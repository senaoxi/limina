import { isNativeTypeScriptProjectInput } from '#checkers';
import ts from 'typescript';
import type {
  TypeScriptSemanticDependencyContext,
  TypeScriptSemanticProject,
} from '../typescript-semantic/contracts';
import { getEffectiveImporterRoots } from '../typescript-semantic/effective-roots';
import { createTypeScriptSemanticContextIdentity } from '../typescript-semantic/identity';
import { createContextRecord, isCompleteImporter } from './context-capture';
import type {
  ImporterRecord,
  InputDependency,
  NativeContextRecord,
  ProjectRecord,
  ResolutionRecord,
} from './contracts';
import { encodeData } from './data-codec';
import { analysisHash, nativeContextId } from './identity';
import {
  observeTypeEnvironment,
  type TypeEnvironmentRecord,
} from './installation-environment';
import type { NativeAnalysisCache } from './native-cache';
import { restoredDependencyContext } from './restored-context';
import type { SemanticState } from './semantic-state';
import { isSameData } from './snapshot-records';

interface Candidate {
  record: NativeContextRecord;
  state: ProjectRecord;
  importers: [string, ImporterRecord][];
  queries: [string, ResolutionRecord][];
}
function isCurrentShape(
  project: TypeScriptSemanticProject,
  candidate: Candidate,
): boolean {
  const roots = getEffectiveImporterRoots(project).filter(
    isNativeTypeScriptProjectInput,
  );
  return [
    analysisHash(roots) === analysisHash(candidate.state.roots),
    candidate.record.boundary.every(
      ([file, allowed]) =>
        project.workspaceSourceBoundary.has(file) === allowed,
    ),
  ].every(Boolean);
}
function isCurrentEnvironment(
  cache: NativeAnalysisCache,
  project: TypeScriptSemanticProject,
  candidate: Candidate,
): boolean {
  const current = observeTypeEnvironment(
    project,
    cache.inputs,
    candidate.state.members,
  );
  if (
    analysisHash(current.domains) !==
    analysisHash(candidate.record.environment.domains)
  )
    cache.inputs.invalidateDomain(project.configPath);
  return (
    current.evidence !== 'unknown' &&
    analysisHash(current) === analysisHash(candidate.record.environment)
  );
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
): Candidate | undefined {
  const record = preferred(cache.contexts, cache.previous?.contexts, id);
  const state = preferred(cache.projects, cache.previous?.projects, id);
  return qualifiedCandidate(cache, record, state);
}
function qualifiedCandidate(
  cache: NativeAnalysisCache,
  record: NativeContextRecord | undefined,
  state: ProjectRecord | undefined,
): Candidate | undefined {
  return [record?.complete, state !== undefined].every(Boolean)
    ? completeCandidate(cache, record!, state!)
    : undefined;
}
function completeCandidate(
  cache: NativeAnalysisCache,
  record: NativeContextRecord,
  state: ProjectRecord,
): Candidate | undefined {
  const importers = Object.values(record.sources)
    .filter((key): key is string => key !== null)
    .map((key) => currentImporter(cache, key));
  const queries = record.queryIds.map((key) => currentQuery(cache, key));
  if (
    [importers.includes(undefined), queries.includes(undefined)].some(Boolean)
  )
    return undefined;
  return {
    record,
    state,
    importers: importers as [string, ImporterRecord][],
    queries: queries as [string, ResolutionRecord][],
  };
}

export class NativeContextRecords {
  readonly #cache: NativeAnalysisCache;
  readonly #compilerInputs = new Map<string, Map<string, InputDependency>>();
  readonly #environments = new Map<string, TypeEnvironmentRecord>();
  readonly #restored = new Map<string, TypeScriptSemanticDependencyContext>();
  constructor(cache: NativeAnalysisCache) {
    this.#cache = cache;
  }
  #compilerDependencies(id: string): Iterable<InputDependency> {
    return this.#compilerInputs.get(id)?.values() ?? [];
  }
  #memoized(
    project: TypeScriptSemanticProject,
    identity: string,
  ): TypeScriptSemanticDependencyContext | undefined {
    return this.#restored.get(identity) ?? this.#restoreNew(project, identity);
  }
  #restoreNew(
    project: TypeScriptSemanticProject,
    identity: string,
  ): TypeScriptSemanticDependencyContext | undefined {
    const candidate = candidateFor(this.#cache, nativeContextId(project));
    if (candidate === undefined) return undefined;
    const valid = [
      isCurrentShape(project, candidate),
      isCurrentEnvironment(this.#cache, project, candidate),
      hasValidInputs(this.#cache, candidate.record.dependencies),
    ];
    return valid.every(Boolean)
      ? this.#adopt(project, identity, candidate)
      : undefined;
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
    cache.inputs.consume(candidate.record.dependencies);
    cache.inputs.consumeNative();
    cache.increment('restoredContexts');
    cache.increment(`environment-${candidate.record.environment.evidence}`);
    const context = restoredDependencyContext(
      identity,
      candidate.record,
      cache.importers,
    );
    this.#restored.set(identity, context);
    return context;
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
  capture(project: TypeScriptSemanticProject, state: SemanticState): void {
    const id = nativeContextId(project);
    const record = createContextRecord({
      cache: this.#cache,
      project,
      state,
      compilerInputs: this.#compilerDependencies(id),
    });
    if (!isSerializableProject(record.project)) {
      this.#cache.fallback('executable-native-options');
      return;
    }
    const previous = this.#cache.previous?.contexts[id];
    this.#cache.contexts[id] = retainContext(previous, record);
  }
  restore(
    project: TypeScriptSemanticProject,
  ): TypeScriptSemanticDependencyContext | undefined {
    const cache = this.#cache;
    if (
      ![
        cache.supports(project, ts),
        cache.hasReusableFacts(project),
        !cache.inputs.domainDirty,
      ].every(Boolean)
    )
      return undefined;
    const identity = createTypeScriptSemanticContextIdentity(project);
    return this.#memoized(project, identity);
  }
}
