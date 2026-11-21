import ts from 'typescript';
import type {
  TypeScriptSemanticDependencyContext,
  TypeScriptSemanticProject,
} from '../typescript-semantic/contracts';
import type { DeclarationEntry } from '../typescript-semantic/declaration-closure';
import { createTypeScriptSemanticContextIdentity } from '../typescript-semantic/identity';
import { hasValidBoundedContext } from './bounded-context-validity';
import { createContextRecord, isCompleteImporter } from './context-capture';
import { hasCurrentContextEnvironment } from './context-environment';
import { isCurrentContextShape } from './context-shape';
import type {
  ImporterRecord,
  InputDependency,
  NativeContextRecord,
  ProjectRecord,
  ResolutionRecord,
} from './contracts';
import { encodeData } from './data-codec';
import type { EpochInputReplay } from './epoch-inputs';
import { nativeContextId } from './identity';
import {
  observeTypeEnvironment,
  type TypeEnvironmentRecord,
} from './installation-environment';
import type { NativeAnalysisCache } from './native-cache';
import { recordCacheHit, recordCacheMiss } from './profile-decisions';
import { hasResolutionReceipt } from './resolution-queries';
import { restoredDependencyContext } from './restored-context';
import type { SemanticState } from './semantic-state';
import { isSameData } from './snapshot-records';

interface Candidate {
  record: NativeContextRecord;
  state: ProjectRecord;
  importers: [string, ImporterRecord][];
  queries: [string, ResolutionRecord][];
}
function hasValidInputs(
  cache: NativeAnalysisCache,
  dependencies: InputDependency[],
): boolean {
  return dependencies.every((dependency) => cache.inputs.valid(dependency));
}
function isSerializableProject(
  project: NativeContextRecord['project'],
): boolean {
  try {
    encodeData(project);
    return true;
  } catch {
    return false;
  }
}
function retainContext(
  previous: NativeContextRecord | undefined,
  record: NativeContextRecord,
): NativeContextRecord {
  return isSameData(previous, record) ? previous! : record;
}
function qualifiedImporter(
  cache: NativeAnalysisCache,
  key: string,
  item: ImporterRecord,
): [string, ImporterRecord] | undefined {
  return [
    isCompleteImporter(item),
    hasValidInputs(cache, item.dependencies),
  ].every(Boolean)
    ? [key, item]
    : undefined;
}
function qualifiedQuery(
  cache: NativeAnalysisCache,
  key: string,
  item: ResolutionRecord,
): [string, ResolutionRecord] | undefined {
  return [
    item.coverage === 'complete',
    hasResolutionReceipt(item),
    hasValidInputs(cache, item.dependencies),
  ].every(Boolean)
    ? [key, item]
    : undefined;
}
function currentImporter(
  cache: NativeAnalysisCache,
  key: string,
): [string, ImporterRecord] | undefined {
  const item = preferred(cache.importers, cache.previous?.importers, key);
  return item === undefined ? undefined : qualifiedImporter(cache, key, item);
}
function currentQuery(
  cache: NativeAnalysisCache,
  key: string,
): [string, ResolutionRecord] | undefined {
  if (
    cache.queries[key] === undefined &&
    cache.invalidation.resolutionDirty.has(key)
  )
    return undefined;
  const item = preferred(cache.queries, cache.previous?.queries, key);
  return item === undefined ? undefined : qualifiedQuery(cache, key, item);
}
function preferred<T>(
  current: Record<string, T>,
  previous: Record<string, T> | undefined,
  key: string,
): T | undefined {
  return current[key] ?? previous?.[key];
}
function candidateFor(
  cache: NativeAnalysisCache,
  id: string,
): Candidate | string {
  if (
    cache.contexts[id] === undefined &&
    cache.invalidation.contextDirty.has(id)
  )
    return 'context-dirty';
  const record = preferred(cache.contexts, cache.previous?.contexts, id);
  if (record === undefined) return 'context-record-absent';
  const state = preferred(cache.projects, cache.previous?.projects, id);
  return state === undefined || !record.complete
    ? 'context-record-incomplete'
    : completeCandidate(cache, record, state);
}
function completeCandidate(
  cache: NativeAnalysisCache,
  record: NativeContextRecord,
  state: ProjectRecord,
): Candidate | string {
  const importers = Object.values(record.sources)
    .filter((key): key is string => key !== null)
    .map((key) => currentImporter(cache, key));
  const queries = record.queryIds.map((key) => currentQuery(cache, key));
  const hasMissingImporter = importers.includes(undefined);
  const hasMissingQuery = queries.includes(undefined);
  if (hasMissingImporter || hasMissingQuery)
    return hasMissingImporter
      ? 'context-importer-unqualified'
      : 'context-resolution-unqualified';
  return {
    record,
    state,
    importers: importers as [string, ImporterRecord][],
    queries: queries as [string, ResolutionRecord][],
  };
}

export class NativeContextRecords {
  readonly #cache: NativeAnalysisCache;
  readonly #revoked = new Set<string>();
  readonly #compilerInputs = new Map<string, Map<string, InputDependency>>();
  readonly #environments = new Map<string, TypeEnvironmentRecord>();
  readonly #restored = new Map<
    string,
    { id: string; context: TypeScriptSemanticDependencyContext }
  >();
  constructor(cache: NativeAnalysisCache) {
    this.#cache = cache;
  }
  #compilerDependencies(id: string): Iterable<InputDependency> {
    return this.#compilerInputs.get(id)?.values() ?? [];
  }
  #restoreNew(
    project: TypeScriptSemanticProject,
    identity: string,
    replay: EpochInputReplay | undefined,
    miss: (code: string, input?: InputDependency) => undefined,
  ): TypeScriptSemanticDependencyContext | undefined {
    const id = nativeContextId(project);
    if (this.#cache.contexts[id] === undefined && this.#revoked.has(id))
      return miss('context-revoked');
    const candidate = candidateFor(this.#cache, id);
    if (typeof candidate === 'string') return miss(candidate);
    const stale = candidate.record.dependencies.find(
      (dependency) => !this.#cache.inputs.valid(dependency),
    );
    if (stale !== undefined) return miss('context-input-stale', stale);
    if (!isCurrentContextShape(project, candidate))
      return miss('context-shape-changed');
    if (!hasCurrentContextEnvironment(this.#cache, project, candidate, replay))
      return miss('context-environment-or-compiler-reads-changed');
    if (
      !hasValidBoundedContext(
        candidate.record,
        Object.fromEntries(candidate.importers),
        {
          project: candidate.state,
          contextId: nativeContextId(project),
          queries: Object.fromEntries(candidate.queries),
        },
      )
    )
      return miss('context-inventory-binding-invalid');
    recordCacheHit(
      'native-context',
      this.#cache.contexts[id] === candidate.record
        ? 'invocation-memory'
        : this.#cache.previousOrigin,
      project.sourceConfigPath ?? project.configPath,
    );
    return this.#adopt(project, identity, candidate);
  }
  #adopt(
    project: TypeScriptSemanticProject,
    identity: string,
    candidate: Candidate,
  ): TypeScriptSemanticDependencyContext {
    const cache = this.#cache;
    for (const [key, item] of candidate.importers) cache.importers[key] = item;
    for (const [key, query] of candidate.queries)
      cache.restoreQuery(key, query);
    const id = nativeContextId(project);
    cache.projects[id] = candidate.state;
    cache.contexts[id] = candidate.record;
    adoptSyntax(cache, candidate.record);
    cache.inputs.consume(candidate.record.dependencies);
    cache.inputs.consumeNative();
    cache.increment('restoredContexts');
    cache.increment(`environment-${candidate.record.environment.evidence}`);
    const context = restoredDependencyContext(
      identity,
      candidate.record,
      cache.importers,
      cache,
    );
    this.#restored.set(identity, { id, context });
    return context;
  }
  evict(id: string): void {
    this.#revoked.add(id);
    for (const [identity, restored] of this.#restored)
      if (restored.id === id) this.#restored.delete(identity);
    this.#compilerInputs.delete(id);
    this.#environments.delete(id);
  }
  begin(project: TypeScriptSemanticProject): void {
    const id = nativeContextId(project);
    this.#compilerInputs.set(id, new Map());
    const environment = observeTypeEnvironment(project, this.#cache.inputs);
    if (environment.evidence === 'unknown')
      this.#cache.fallback('type-environment-unknown');
    this.#environments.set(id, environment);
  }
  observe(
    project: TypeScriptSemanticProject,
    dependency: InputDependency,
  ): void {
    this.#compilerInputs
      .get(nativeContextId(project))
      ?.set(dependency.inputId, dependency);
  }
  environment(id: string): TypeEnvironmentRecord | undefined {
    return this.#environments.get(id);
  }
  capture(
    project: TypeScriptSemanticProject,
    state: SemanticState,
    observation: { isComplete: boolean; entries: DeclarationEntry[] },
  ): void {
    const id = nativeContextId(project);
    const record = createContextRecord({
      typeEntries: observation.entries,
      cache: this.#cache,
      project,
      state,
      compilerInputs: this.#compilerDependencies(id),
    });
    record.complete = [record.complete, observation.isComplete].every(Boolean);
    if (!isSerializableProject(record.project)) {
      this.#cache.fallback('executable-native-options');
      return;
    }
    const previous = this.#cache.previous?.contexts[id];
    this.#cache.contexts[id] = retainContext(previous, record);
  }
  restore(
    project: TypeScriptSemanticProject,
    replay?: EpochInputReplay,
    onMiss?: (decision: string) => void,
  ): TypeScriptSemanticDependencyContext | undefined {
    const cache = this.#cache;
    const file = project.sourceConfigPath ?? project.configPath;
    const miss = (code: string, input?: InputDependency): undefined => {
      const observation =
        input === undefined
          ? undefined
          : (cache.inputs.records[input.inputId] ??
            cache.inputs.previous[input.inputId]);
      const decision = recordCacheMiss('native-context', code, {
        file,
        absent: code === 'context-record-absent' || undefined,
        bypassed:
          ['unsupported-native-context', 'executable-native-context'].includes(
            code,
          ) || undefined,
        input:
          observation === undefined
            ? undefined
            : { kind: observation.kind, file: observation.path },
        basis: cache.snapshotDecision,
      });
      if (decision !== undefined) onMiss?.(decision);
    };
    const checks = [
      [cache.supports(project, ts), 'unsupported-native-context'],
      [cache.hasReusableFacts(project), 'executable-native-context'],
    ] as const;
    const incompatible = checks.find(([isQualified]) => !isQualified);
    if (incompatible !== undefined) return miss(incompatible[1]);
    if (cache.inputs.domainDirty) return miss('manifest-domain-changed');
    const identity = createTypeScriptSemanticContextIdentity(project);
    const memoized = this.#restored.get(identity);
    if (memoized !== undefined) {
      recordCacheHit('native-context', 'invocation-memory', file);
      return memoized.context;
    }
    return this.#restoreNew(project, identity, replay, miss);
  }
}

function adoptSyntax(
  cache: NativeAnalysisCache,
  record: NativeContextRecord,
): void {
  const witnesses = record.native?.inventory.syntax ?? [];
  for (const witness of witnesses) {
    const syntax = previousSyntax(cache, witness.file);
    if (syntax !== undefined) cache.retainSyntax(syntax, witness.fingerprint);
  }
}
function previousSyntax(cache: NativeAnalysisCache, file: string) {
  return cache.previous?.files[file];
}
