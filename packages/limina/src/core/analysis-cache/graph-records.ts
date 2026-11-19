import { normalizeAbsolutePath } from '#utils/path';
import type {
  GraphRecord,
  NativeContextRecord,
  ResolutionRecord,
} from './contracts';
import { type DataNode, encodeData } from './data-codec';
import type { EpochInputReplay } from './epoch-inputs';
import { analysisHash } from './identity';
import type { NativeAnalysisCache } from './native-cache';
import { availableSnapshotGraphs } from './snapshot-graphs';
import { isSameData } from './snapshot-records';
function isCompleteContext(context: NativeContextRecord): boolean {
  return context.complete && hasCompleteContextInputs(context);
}
function hasCompleteContextInputs(context: NativeContextRecord): boolean {
  return (
    context.environment.evidence !== 'unknown' &&
    hasCompletedNativeCollection(context)
  );
}
function hasCompletedNativeCollection(context: NativeContextRecord): boolean {
  return (
    context.native === undefined || context.native.snapshot.run === 'completed'
  );
}
function previousGraph(
  cache: NativeAnalysisCache,
  key: string,
): GraphRecord | undefined {
  return cache.graphs[key] ?? availableSnapshotGraphs(cache.previous)?.[key];
}
function previousContext(
  cache: NativeAnalysisCache,
  key: string,
): NativeContextRecord | undefined {
  return cache.contexts[key] ?? cache.previous?.contexts[key];
}
function isCurrentGraph(
  cache: NativeAnalysisCache,
  record: GraphRecord,
  workspaceVersion: string,
): boolean {
  return [
    !cache.inputs.domainDirty,
    record.workspaceVersion === workspaceVersion,
    record.dependencies.every((dependency) => cache.inputs.valid(dependency)),
  ].every(Boolean);
}
function graphConfigPaths(cache: NativeAnalysisCache, record: GraphRecord) {
  return new Set(
    record.dependencies.flatMap(({ inputId }) => {
      const input = cache.inputs.records[inputId];
      return input?.kind === 'config-mtime' &&
        cache.inputs.configCurrent([input.path])
        ? [input.path]
        : [];
    }),
  );
}
function isAllowed(allowed: Map<string, boolean>, file: string): boolean {
  return allowed.get(normalizeAbsolutePath(file)) ?? false;
}
function canRestoreContext(
  cache: NativeAnalysisCache,
  id: string,
  replay: EpochInputReplay,
): boolean {
  const context = previousContext(cache, id);
  if (context === undefined) return false;
  const allowed = new Map(context.boundary);
  return (
    cache.restoreContext(
      {
        ...context.project,
        workspaceSourceBoundary: {
          ...restoredNativeBoundary(context),
          has: (file) => isAllowed(allowed, file),
        },
      },
      replay,
    ) !== undefined
  );
}
function graphData(value: unknown): DataNode | undefined {
  try {
    return encodeData(value);
  } catch {
    return undefined;
  }
}
function previousGraphQuery(
  cache: NativeAnalysisCache,
  id: string,
): ResolutionRecord | undefined {
  return cache.queries[id] ?? cache.previous?.queries[id];
}
function isReusableGraphQuery(
  cache: NativeAnalysisCache,
  query: ResolutionRecord | undefined,
): query is ResolutionRecord {
  if (query === undefined) return false;
  return [
    query.coverage === 'complete',
    query.dependencies.every((input) => cache.inputs.valid(input)),
  ].every(Boolean);
}
function didRestoreGraphQuery(cache: NativeAnalysisCache, id: string): boolean {
  if (
    cache.queries[id] === undefined &&
    cache.invalidation.resolutionDirty.has(id)
  )
    return false;
  const query = previousGraphQuery(cache, id);
  if (!isReusableGraphQuery(cache, query)) return false;
  cache.restoreQuery(id, query);
  return true;
}
interface Capture {
  workspaceVersion: string;
  value: unknown;
}
export class CachedGraphRecords {
  readonly #cache: NativeAnalysisCache;
  constructor(cache: NativeAnalysisCache) {
    this.#cache = cache;
  }
  #captureData(
    key: string,
    options: Capture,
    discovery: GraphRecord['discovery'],
  ): void {
    const data = graphData(options.value);
    if (data === undefined) {
      this.#cache.fallback('graph-executable-provider');
      return;
    }
    const record: GraphRecord = {
      workspaceVersion: options.workspaceVersion,
      queryIds: [...this.#cache.retainedQueryIds],
      contextIds: Object.keys(this.#cache.contexts),
      vueContextIds: Object.keys(this.#cache.vue.records),
      dependencies: Object.entries(this.#cache.snapshotRecords().inputs).map(
        ([inputId, input]) => ({ inputId, expectedVersion: input.version }),
      ),
      discovery,
      data,
    };
    this.#retain(key, record);
  }
  #retain(key: string, record: GraphRecord): void {
    const previous = availableSnapshotGraphs(this.#cache.previous)?.[key];
    this.#cache.graphs[key] = isSameData(previous, record) ? previous! : record;
  }
  candidate(key: string, workspaceVersion: string): GraphRecord | undefined {
    const old = previousGraph(this.#cache, key);
    return old && isCurrentGraph(this.#cache, old, workspaceVersion)
      ? old
      : undefined;
  }
  async restore(
    key: string,
    record: GraphRecord,
    generation: number,
  ): Promise<GraphRecord | undefined> {
    const replay = this.#cache.resolvedConfigs.replay();
    if (
      !(await this.#cache.epoch.validate(
        record.discovery,
        replay,
        graphConfigPaths(this.#cache, record),
      )) ||
      record.vueContextIds.some(
        (id) => !this.#cache.vue.restore(id, replay, generation),
      ) ||
      record.contextIds.some(
        (id) => !canRestoreContext(this.#cache, id, replay),
      ) ||
      record.queryIds.some((id) => !didRestoreGraphQuery(this.#cache, id)) ||
      this.#cache.inputs.domainDirty
    )
      return undefined;
    this.#cache.inputs.consume(record.dependencies);
    this.#cache.contributions.restoreValidatedGraph();
    const discovery = this.#cache.epoch.refreshConfigStamps(record.discovery);
    const current =
      discovery === record.discovery ? record : { ...record, discovery };
    this.#cache.graphs[key] = current;
    return current;
  }
  capture(key: string, options: Capture): void {
    const discovery = this.#cache.epoch.snapshot();
    const isComplete = Object.values(this.#cache.contexts).every(
      isCompleteContext,
    );
    if (
      ![
        discovery !== undefined,
        !this.#cache.requiresSupplementalReassessment,
        isComplete,
        this.#cache.hasCompleteGraphContextCoverage(),
        this.#cache.vue.complete(),
      ].every(Boolean)
    ) {
      this.#cache.fallback('graph-proof-unknown');
      return;
    }
    this.#captureData(key, options, discovery!);
  }
}

function restoredNativeBoundary(context: NativeContextRecord) {
  const native = context.native;
  return native === undefined
    ? { identity: analysisHash(context.boundary) }
    : {
        identity: native.boundaryIdentity,
        sourceConfigCoverage: native.snapshot.coverageIndexes[0],
      };
}
