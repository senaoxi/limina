import { normalizeAbsolutePath } from '#utils/path';
import { PathBindingReplay } from '../analysis-cache/directory-fingerprint';
import { analysisHash } from '../analysis-cache/identity';
import { appendVueExecutionInputs } from '../analysis-cache/vue-execution-inputs';
import { collectDeclarationCompilationEvidence } from '../declaration-governance/evidence';
import { managedOutputLookupIdentity } from '../import-graph/managed-output-provider';
import { effectiveCompilerOptions } from '../typescript-semantic/compiler-options';
import { withVueDeclarationLoading } from '../vue-semantic/loading-identity';
import {
  cloneProjectDependencyCollection,
  getProjectSemanticCacheIdentity,
} from './cache';
import type {
  ProjectDependency,
  ProjectDependencyCaches,
  ProjectDependencyCollection,
  ProjectDependencyObservation,
  ProjectDependencyRequest,
} from './contracts';
import { collectionReferenceInputs } from './declaration-projection';
import { getWorkspaceSourceBoundarySnapshotIdentity } from './identity';
import { retainNativeObservation } from './native-evidence-retention';
import { collectProjectDependencyFile } from './preparation';
import {
  createCollectionContext,
  projectDependencyFactsKey,
  restoreCollectionContext,
} from './semantic-facts';
import { collectSupportContributions } from './support-contributions';

interface CollectionReplay {
  collection: ProjectDependencyCollection;
  vueIdentity: ProjectDependencyRequest['context']['vueSemanticIdentity'];
}

const collectionReplays = new WeakMap<
  ProjectDependencyCaches,
  Map<string, CollectionReplay>
>();

/**
Reuse owned collections only within one synchronous, read-only projection.
*/
export function withProjectDependencyReplay<T>(
  caches: ProjectDependencyCaches,
  collect: () => T,
): T {
  const isActive = collectionReplays.has(caches);
  if (!isActive) collectionReplays.set(caches, new Map());
  try {
    return collect();
  } finally {
    if (!isActive) collectionReplays.delete(caches);
  }
}

function createEmptyCollection(): ProjectDependencyCollection {
  return { dependencies: [], failures: [], observations: [] };
}
function getCachedCollection(options: {
  cacheKey: string;
  request: ProjectDependencyRequest;
}): ProjectDependencyCollection | undefined {
  if (
    managedOutputLookupIdentity(options.request.managedOutputLookup) ===
    undefined
  )
    return undefined;
  const caches = options.request.caches;
  return caches === undefined
    ? undefined
    : readCachedCollection(caches, options.cacheKey, options.request.context);
}
function readCachedCollection(
  caches: ProjectDependencyCaches,
  key: string,
  context: ProjectDependencyRequest['context'],
): ProjectDependencyCollection | undefined {
  if (caches.analysisCache === undefined) {
    const cached = caches.projectDependencyCache.get(key);
    return cached === undefined
      ? undefined
      : cloneProjectDependencyCollection(cached);
  }
  const replay = collectionReplays.get(caches)?.get(key);
  if (replay === undefined) return undefined;
  if (
    replay.vueIdentity !== undefined &&
    context.vueSemanticIdentity !== undefined
  )
    appendVueExecutionInputs(replay.vueIdentity, context.vueSemanticIdentity);
  caches.analysisCache.increment('collectionReplayHits');
  return cloneProjectDependencyCollection(replay.collection);
}

function cacheCollection(options: {
  cacheKey: string;
  collection: ProjectDependencyCollection;
  request: ProjectDependencyRequest;
}): void {
  retainNativeObservation(
    options.request.caches,
    options.collection.nativeEvidence,
  );
  collectionReferenceInputs(options.collection);
  if (
    managedOutputLookupIdentity(options.request.managedOutputLookup) ===
    undefined
  )
    return;
  const caches = options.request.caches;
  if (caches === undefined) return;
  if (caches.analysisCache === undefined) {
    caches.projectDependencyCache.set(
      options.cacheKey,
      cloneProjectDependencyCollection(options.collection),
    );
    return;
  }
  collectionReplays.get(caches)?.set(options.cacheKey, {
    collection: cloneProjectDependencyCollection(options.collection),
    vueIdentity: options.request.context.vueSemanticIdentity,
  });
}

function deduplicateFailures(collection: ProjectDependencyCollection): void {
  collection.failures = new Map(
    collection.failures.map((failure) => [failure.identity, failure]),
  )
    .values()
    .toArray();
}

export function nativeConfigContextKey(
  context: ProjectDependencyRequest['context'],
): string {
  const virtuals =
    context.virtualFiles === undefined || context.virtualFiles.size === 0
      ? null
      : analysisHash(Array.from(context.virtualFiles));
  // Preserve `compilerOptions.paths` declaration order by using order-preserving JSON hashing.
  return JSON.stringify([
    normalizeAbsolutePath(context.configPath),
    normalizeAbsolutePath(context.resolverConfigPath),
    context.generation,
    analysisHash(effectiveCompilerOptions(context.compilerOptions)),
    context.semanticAuthority.family,
    context.analysisChecker ?? 'tsc',
    context.fileNames.map(normalizeAbsolutePath),
    context.references,
    getWorkspaceSourceBoundarySnapshotIdentity(context.workspaceSourceBoundary),
    virtuals,
  ]);
}

export function lookupSharedNativeContext(
  request: Pick<ProjectDependencyRequest, 'caches' | 'context'>,
): NonNullable<ProjectDependencyRequest['typeScriptSemanticContext']> | null {
  const contexts = request.caches?.nativeContextsByConfig;
  return contexts === undefined ||
    request.context.semanticAuthority.family !== 'typescript'
    ? null
    : (contexts.get(nativeConfigContextKey(request.context)) ?? null);
}

export function registerNativeConfigContext(
  request: ProjectDependencyRequest,
  context: NonNullable<ProjectDependencyRequest['typeScriptSemanticContext']>,
): void {
  if (request.context.semanticAuthority.family !== 'typescript') return;
  const contexts = request.caches?.nativeContextsByConfig;
  if (contexts === undefined) return;
  contexts.set(nativeConfigContextKey(request.context), context);
}

function collectProjectDependenciesWithNewContext(options: {
  factsCacheKey: string;
  request: ProjectDependencyRequest;
}): ProjectDependencyCollection {
  const collection = createEmptyCollection();
  const typeScriptSemanticContext = createCollectionContext(options.request);
  const semanticRequest = {
    ...options.request,
    typeScriptSemanticContext,
  };
  try {
    for (const fileName of options.request.context.fileNames) {
      collectProjectDependencyFile({
        collection,
        fileName,
        request: semanticRequest,
      });
    }
    collectSupportContributions(collection, semanticRequest);
    options.request.caches?.typeScriptSemanticFactsCache.set(
      options.factsCacheKey,
      typeScriptSemanticContext,
    );
    registerNativeConfigContext(options.request, typeScriptSemanticContext);
  } finally {
    typeScriptSemanticContext.dispose();
  }
  deduplicateFailures(collection);
  return collection;
}

function collectProjectDependenciesWithContext(options: {
  request: ProjectDependencyRequest;
  factsCacheKey: string;
  typeScriptSemanticContext: NonNullable<
    ProjectDependencyRequest['typeScriptSemanticContext']
  >;
}): ProjectDependencyCollection {
  options.request.caches?.typeScriptSemanticFactsCache.set(
    options.factsCacheKey,
    options.typeScriptSemanticContext,
  );
  registerNativeConfigContext(
    options.request,
    options.typeScriptSemanticContext,
  );
  const collection = createEmptyCollection();
  const request = {
    ...options.request,
    typeScriptSemanticContext: options.typeScriptSemanticContext,
  };
  for (const fileName of request.context.fileNames) {
    collectProjectDependencyFile({ collection, fileName, request });
  }
  collectSupportContributions(collection, request);
  deduplicateFailures(collection);
  return collection;
}

function cachedCollectionContext(options: {
  factsCacheKey: string;
  request: ProjectDependencyRequest;
}) {
  return (
    options.request.caches?.typeScriptSemanticFactsCache.get(
      options.factsCacheKey,
    ) ?? restoreCollectionContext(options.request)
  );
}
function collectUncachedProjectDependencies(options: {
  factsCacheKey: string;
  request: ProjectDependencyRequest;
}): ProjectDependencyCollection {
  if (options.request.context.semanticAuthority.family === 'vue') {
    return collectVueDependencies(options.request);
  }
  const cachedContext = cachedCollectionContext(options);
  if (cachedContext === undefined) {
    return collectProjectDependenciesWithNewContext(options);
  }
  return collectProjectDependenciesWithContext({
    ...options,
    typeScriptSemanticContext: cachedContext,
  });
}

export function collectProjectDependencies(
  input: ProjectDependencyRequest,
): ProjectDependencyCollection {
  const request = withDeclarationLoading(input);
  const projectSemanticIdentity = getProjectSemanticCacheIdentity(request);
  const cacheKey = JSON.stringify([
    projectSemanticIdentity,
    request.compilationObligationScope,
  ]);
  const cached = getCachedCollection({ cacheKey, request });
  if (cached !== undefined) return cached;
  const semanticRequest = {
    ...request,
    projectSemanticCacheIdentity: projectSemanticIdentity,
  };
  const factsCacheKey = projectDependencyFactsKey(semanticRequest);
  const collection = collectUncachedProjectDependencies({
    factsCacheKey,
    request: semanticRequest,
  });
  collection.declarationEvidence = collectDeclarationCompilationEvidence(
    collection,
    semanticRequest,
  );
  cacheCollection({
    cacheKey,
    collection,
    request: semanticRequest,
  });
  return collection;
}

export function withDeclarationLoading(
  request: ProjectDependencyRequest,
): ProjectDependencyRequest {
  const identity = request.context.vueSemanticIdentity;
  const coverage =
    request.caches?.sourceConfigCoverage ??
    request.context.workspaceSourceBoundary.sourceConfigCoverage;
  if (identity === undefined || coverage === undefined) return request;
  const declarationLoading = {
    version: 1 as const,
    sourceConfig:
      identity.declarationLoading?.sourceConfig ??
      request.context.resolverConfigPath,
    purpose: 'graph' as const,
    coverage,
  };
  return {
    ...request,
    context: {
      ...request.context,
      vueSemanticIdentity: withVueDeclarationLoading(
        identity,
        declarationLoading,
      ),
    },
  };
}

export function isProjectDependencyCreatesSourceEdge(
  dependency:
    | ProjectDependency
    | Extract<ProjectDependencyObservation, { kind: 'unmapped-generated' }>,
): dependency is ProjectDependency {
  return 'provenance' in dependency;
}

function collectVueDependencies(
  request: ProjectDependencyRequest,
): ProjectDependencyCollection {
  // The compiler collection is synchronous and read-only. Each collection gets
  // fresh bindings. Content reads and independent later fences stay live.
  return new PathBindingReplay({ reuseLeafBindings: true }).run(() => {
    const collection = createEmptyCollection();
    const identity = request.context.vueSemanticIdentity;
    const graphRequest = {
      ...request,
      vueGraphFacts:
        identity !== undefined &&
        request.purpose === undefined &&
        request.runtimeSourceResolver === undefined
          ? request.importAnalysis.restoreVueGraphFacts?.(identity)
          : undefined,
    };
    for (const fileName of request.context.fileNames)
      collectProjectDependencyFile({
        collection,
        fileName,
        request: graphRequest,
      });
    collectSupportContributions(collection, graphRequest);
    deduplicateFailures(collection);
    return collection;
  });
}
