import { isNativeTypeScriptProjectInput } from '#checkers';
import ts from 'typescript';
import type { NativeRequest } from '../../domain/analysis/native-evidence';
import { effectiveCompilerOptions } from '../typescript-semantic/compiler-options';
import { nativeCompilerPathPolicy } from '../typescript-semantic/compiler-path-key';
import type { TypeScriptSemanticProject } from '../typescript-semantic/contracts';
import { nativeFingerprint } from '../typescript-semantic/native-file-identity';
import { hasValidBoundedContext } from './bounded-context-validity';
import { isCompleteImporter } from './context-capture';
import { hasCurrentTypeEnvironment } from './context-environment';
import { isCurrentContextShape } from './context-shape';
import type {
  AnalysisSnapshot,
  DiscoveryRecord,
  InputDependency,
  NativeContextRecord,
} from './contracts';
import { type EpochInputReplay, EpochInputs } from './epoch-inputs';
import { nativeContextId } from './identity';
import type { NativeAnalysisCache } from './native-cache';
import { hasResolutionReceipt } from './resolution-queries';
import { hasStoredNativeBindings } from './snapshot-schema';

type BoundedRecord = NativeContextRecord & {
  native: NonNullable<NativeContextRecord['native']>;
};
type Inclusions = NonNullable<
  BoundedRecord['native']['inventory']['inclusions']
>;

export interface BoundedObservationPlan {
  record: BoundedRecord;
  observationRoots: string[];
  dirtySources: ReadonlySet<string>;
  reusableFiles: ReadonlySet<string>;
  cleanQueryIds: ReadonlySet<string>;
  priorDiscovery: EpochInputs;
}

interface PreviousContext {
  previous: AnalysisSnapshot;
  record: BoundedRecord;
  inclusions: Inclusions;
  roots: string[];
  configs: Set<string>;
}

function hasCompleteBoundedRecord(
  record: NativeContextRecord | undefined,
): record is BoundedRecord {
  return record?.complete === true && record.native !== undefined;
}

function hasSameProject(
  project: TypeScriptSemanticProject,
  record: BoundedRecord,
  roots: string[],
): boolean {
  const inputs = record.native.snapshot.contexts[0]?.inputs;
  const coverage = project.workspaceSourceBoundary.sourceConfigCoverage;
  return (
    inputs !== undefined &&
    coverage !== undefined &&
    [
      inputs.config === project.configPath,
      inputs.sourceConfig === (project.sourceConfigPath ?? project.configPath),
      inputs.roots === nativeFingerprint(roots),
      inputs.options ===
        nativeFingerprint(effectiveCompilerOptions(project.options)),
      inputs.rawReferences ===
        nativeFingerprint(project.projectReferences ?? []),
      inputs.coverage === nativeFingerprint(coverage),
      inputs.compilationScope ===
        (project.compilationObligationScope ?? 'source-options'),
      nativeFingerprint([record.project.analysisBinding]) ===
        nativeFingerprint([project.analysisBinding]),
    ].every(Boolean)
  );
}

function hasValidDependencies(
  cache: NativeAnalysisCache,
  dependencies: readonly InputDependency[],
): boolean {
  return dependencies.every((dependency) => cache.inputs.valid(dependency));
}

function qualifiedPrevious(
  cache: NativeAnalysisCache,
  project: TypeScriptSemanticProject,
): PreviousContext | undefined {
  if (
    project.admissionMode !== 'coverage-bounded' ||
    cache.previous === undefined ||
    cache.inputs.toolchainChanged ||
    !cache.supports(project, ts) ||
    !cache.hasReusableFacts(project)
  )
    return undefined;
  const previous = cache.previous;
  const contextId = nativeContextId(project);
  const record = previous.contexts[contextId];
  const state = previous.projects[contextId];
  if (
    state === undefined ||
    !hasCompleteBoundedRecord(record) ||
    cache.invalidation.contextDirty.has(contextId)
  )
    return undefined;
  const inclusions = record.native.inventory.inclusions;
  const owner = project.sourceConfigPath ?? project.configPath;
  const closure = cache.configClosures.get(owner);
  const roots = project.fileNames.filter(isNativeTypeScriptProjectInput);
  return inclusions !== undefined &&
    closure !== undefined &&
    cache.inputs.configCurrent(closure) &&
    isCurrentContextShape(project, { record, state }) &&
    hasSameProject(project, record, roots) &&
    (hasStoredNativeBindings(previous) ||
      hasValidBoundedContext(record, previous.importers, {
        project: state,
        contextId,
        queries: previous.queries,
      })) &&
    hasCurrentTypeEnvironment(cache, project, { record, state }) &&
    hasValidDependencies(cache, record.dependencies) &&
    hasValidDependencies(cache, record.sharedEnvironment.dependencies) &&
    !cache.invalidation.contextDirty.has(contextId) &&
    !cache.inputs.toolchainChanged
    ? { record, previous, inclusions, roots, configs: new Set(closure) }
    : undefined;
}

type Source = string | null;

function addTo<K, V>(values: Map<K, Set<V>>, key: K, value: V): void {
  const entries = values.get(key) ?? new Set<V>();
  entries.add(value);
  values.set(key, entries);
}

function requestSource(request: NativeRequest): Source {
  return request.sourceFile?.lexicalPath ?? null;
}

function observedPaths(
  resolution: BoundedRecord['native']['snapshot']['resolutions'][number],
): string[] {
  const { target, pathSelection } = resolution;
  const paths = target === null ? [] : [target.lexicalPath];
  if (pathSelection !== undefined) {
    paths.push(pathSelection.lexicalPath);
    if (pathSelection.logicalTarget !== null)
      paths.push(pathSelection.logicalTarget);
    for (const candidate of pathSelection.candidates)
      paths.push(candidate.lexicalPath, candidate.physicalPath);
  }
  return paths;
}

function isContentRead(kind: DiscoveryRecord['descriptor']['kind']): boolean {
  return [
    'content',
    'typescript-content',
    'source-digest',
    'file-digest',
    'file-size',
  ].includes(kind);
}

/**
 * A local view of the already observed source, request, and load relationships.
 * Compiler path keys join aliases without widening membership by physical identity.
 */
class ObservationSources {
  readonly #key = nativeCompilerPathPolicy().key;
  readonly #files: Map<string, string[]>;
  readonly #targetReads = new Map<string, Set<Source>>();
  readonly #includedBy = new Map<string, Set<Source>>();
  readonly #roots = new Map<string, Set<string>>();
  #environmentDirty = false;
  readonly dirty = new Set<string>();

  constructor({ record, roots, inclusions }: PreviousContext) {
    const { inventory, snapshot } = record.native;
    this.#files = Map.groupBy(Object.keys(record.sources), this.#key);
    const requests = new Map(
      snapshot.requests.map((request) => [request.id, request]),
    );
    const currentRoots = new Set(roots);
    for (const { root, source } of inventory.roots)
      if (currentRoots.has(root)) addTo(this.#roots, source, root);
    for (const resolution of snapshot.resolutions) {
      const source = requestSource(requests.get(resolution.requestId)!);
      for (const file of observedPaths(resolution))
        addTo(this.#targetReads, this.#key(file), source);
    }
    for (const load of inventory.loads)
      addTo(this.#targetReads, this.#key(load.target), load.source);
    for (const entry of inclusions.requests)
      addTo(
        this.#includedBy,
        entry.source,
        requestSource(requests.get(entry.requestId)!),
      );
    for (const source of inclusions.projectReferences)
      addTo(this.#includedBy, source, null);
  }

  #mark(source: Source): void {
    if (source === null) this.#environmentDirty = true;
    else this.dirty.add(source);
  }

  #trace(source: string, roots: Set<string>): boolean {
    const pending: Source[] = [source];
    const visited = new Set<Source>();
    let hasSeed = false;
    for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
      if (visited.has(file)) continue;
      visited.add(file);
      if (file === null) {
        this.#environmentDirty = true;
        hasSeed = true;
        continue;
      }
      const direct = this.#roots.get(file);
      if (direct === undefined) {
        const parents = this.#includedBy.get(file) ?? [];
        for (const parent of parents) pending.push(parent);
      } else {
        for (const root of direct) roots.add(root);
        hasSeed = true;
      }
    }
    return hasSeed;
  }

  markFile(file: string): boolean {
    const sources = this.#files.get(this.#key(file));
    if (sources === undefined) return false;
    for (const source of sources) this.#mark(source);
    return true;
  }

  markRead(read: DiscoveryRecord): boolean {
    const { descriptor, path } = read;
    if (!('path' in descriptor) || descriptor.path !== path) return false;
    // Even a loaded JSON member can also determine the module format of
    // other sources through the compiler's package scope.
    if (this.#key(path).endsWith('/package.json')) return false;
    const { kind } = descriptor;
    const isContent = isContentRead(kind);
    if (
      !isContent &&
      !['file', 'file-binding', 'file-identity', 'realpath'].includes(kind)
    )
      return false;
    // A source text edit needs fresh evidence for that source. A changed
    // binding or selection may also change which source a request includes.
    const hasSource = this.markFile(path);
    if (hasSource && isContent) return true;
    const targets = this.#targetReads.get(this.#key(path));
    if (targets === undefined) return hasSource;
    for (const target of targets) this.#mark(target);
    return true;
  }

  observationRoots(roots: string[]): string[] | undefined {
    const selected = new Set<string>();
    if (this.dirty.values().some((source) => !this.#trace(source, selected)))
      return undefined;
    if (this.#environmentDirty && selected.size === 0 && roots[0] !== undefined)
      selected.add(roots[0]);
    return selected.size === 0
      ? undefined
      : roots.filter((root) => selected.has(root));
  }
}

function currentQueries(
  cache: NativeAnalysisCache,
  candidate: PreviousContext,
  sources: ObservationSources,
): Set<string> | undefined {
  const clean = new Set<string>();
  for (const id of candidate.record.queryIds) {
    const query = candidate.previous.queries[id];
    if (
      query.coverage === 'complete' &&
      hasResolutionReceipt(query) &&
      !cache.invalidation.resolutionDirty.has(id) &&
      hasValidDependencies(cache, query.dependencies)
    )
      clean.add(id);
    else if (!sources.markFile(query.file)) return undefined;
  }
  return clean;
}

export function planBoundedObservation(
  cache: NativeAnalysisCache,
  project: TypeScriptSemanticProject,
  replay: EpochInputReplay = cache.configReads.replay(),
): BoundedObservationPlan | undefined {
  const candidate = qualifiedPrevious(cache, project);
  if (candidate === undefined) return undefined;
  const { record, previous, configs } = candidate;
  const priorDiscovery = new EpochInputs(cache.inputs);
  const staleReads = record.native.discovery.filter(
    (receipt) =>
      !priorDiscovery.validateSynchronous([receipt], replay, configs),
  );
  const sources = new ObservationSources(candidate);
  if (staleReads.some((receipt) => !sources.markRead(receipt)))
    return undefined;
  const cleanQueryIds = currentQueries(cache, candidate, sources);
  if (cleanQueryIds === undefined) return undefined;
  for (const [file, id] of Object.entries(record.sources)) {
    const importer = previous.importers[id!];
    if (
      cache.invalidation.syntaxDirty.has(id!) ||
      cache.invalidation.semanticDirty.has(id!) ||
      !isCompleteImporter(importer) ||
      !hasValidDependencies(cache, importer.dependencies)
    )
      sources.dirty.add(file);
  }
  const observationRoots = sources.observationRoots(candidate.roots);
  return observationRoots === undefined
    ? undefined
    : {
        record,
        observationRoots,
        dirtySources: sources.dirty,
        reusableFiles: new Set(
          Object.keys(record.sources).filter(
            (file) => !sources.dirty.has(file),
          ),
        ),
        cleanQueryIds,
        priorDiscovery,
      };
}
