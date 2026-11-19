import { isNativeTypeScriptProjectInput } from '#checkers';
import { PathBindingReplay } from '../analysis-cache/directory-fingerprint';
import { collectDeclarationCompilationEvidence } from '../declaration-governance/evidence';
import { managedOutputLookupIdentity } from '../import-graph/managed-output-provider';
import {
  createTypeScriptDependencyContext,
  createTypeScriptProjectDependencyFactsIdentity,
  createTypeScriptSemanticDependencySnapshot,
} from '../typescript-semantic';
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
import { collectSupportContributions } from './support-contributions';

const collectionReplays = new WeakMap<
  ProjectDependencyCaches,
  Map<string, ProjectDependencyCollection>
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
    : readCachedCollection(caches, options.cacheKey);
}
function readCachedCollection(
  caches: NonNullable<ProjectDependencyRequest['caches']>,
  key: string,
): ProjectDependencyCollection | undefined {
  const cached = collectionMemo(caches)?.get(key);
  if (cached !== undefined)
    caches.analysisCache?.increment('collectionReplayHits');
  return cached === undefined
    ? undefined
    : cloneProjectDependencyCollection(cached);
}

function collectionMemo(caches: ProjectDependencyCaches) {
  return caches.analysisCache === undefined
    ? caches.projectDependencyCache
    : collectionReplays.get(caches);
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
  collectionMemo(caches)?.set(
    options.cacheKey,
    cloneProjectDependencyCollection(options.collection),
  );
}

function deduplicateFailures(collection: ProjectDependencyCollection): void {
  collection.failures = new Map(
    collection.failures.map((failure) => [failure.identity, failure]),
  )
    .values()
    .toArray();
}

function createCollectionContext(request: ProjectDependencyRequest) {
  return createTypeScriptDependencyContext(
    collectionProject(request),
    collectionServices(request),
  );
}

function restoreCollectionContext(
  request: ProjectDependencyRequest,
): ProjectDependencyRequest['typeScriptSemanticContext'] {
  return persistentCollectionCache(request)?.restoreContext(
    collectionProject(request),
  );
}
function collectionBinding(request: ProjectDependencyRequest) {
  const { context } = request;
  const family = context.semanticAuthority.family;
  return {
    phase: 'locked' as const,
    checker: context.analysisChecker ?? 'tsc',
    ...((family === 'astro' || family === 'svelte') && {
      workspaceSourceBoundaryIdentity:
        getWorkspaceSourceBoundarySnapshotIdentity(
          context.workspaceSourceBoundary,
        ),
    }),
  };
}
function collectionProject(request: ProjectDependencyRequest) {
  return {
    compilationObligationScope: request.compilationObligationScope,
    admissionMode: 'coverage-bounded' as const,
    analysisBinding: collectionBinding(request),
    configPath: request.context.configPath,
    sourceConfigPath: request.context.resolverConfigPath,
    fileNames: request.context.fileNames,
    options: request.context.compilerOptions,
    projectReferences: request.context.references,
    virtualFiles: request.context.virtualFiles,
    workspaceSourceBoundary: request.context.workspaceSourceBoundary,
  };
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
    const snapshot = createTypeScriptSemanticDependencySnapshot({
      context: typeScriptSemanticContext,
      fileNames: options.request.context.fileNames,
    });
    options.request.caches?.typeScriptSemanticFactsCache.set(
      options.factsCacheKey,
      snapshot,
    );
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
  const factsCacheKey = JSON.stringify([
    projectSemanticIdentity,
    createTypeScriptProjectDependencyFactsIdentity({
      compilationObligationScope: request.compilationObligationScope,
      analysisBinding: collectionBinding(request),
      configPath: request.context.configPath,
      sourceConfigPath: request.context.resolverConfigPath,
      fileNames: request.context.fileNames,
      options: request.context.compilerOptions,
      projectReferences: request.context.references,
      virtualFiles: request.context.virtualFiles,
      workspaceSourceBoundary: request.context.workspaceSourceBoundary,
    }),
  ]);
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

function withDeclarationLoading(
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

function collectionServices(request: ProjectDependencyRequest) {
  const caches = request.caches;
  if (caches === undefined) return {};
  return {
    analysisCache: persistentCollectionCache(request),
    metrics: caches.metrics,
  };
}

function persistentCollectionCache(request: ProjectDependencyRequest) {
  const cache = request.caches?.analysisCache;
  return cache === undefined ? cache : eligibleCollection(cache, request);
}
function eligibleCollection(
  cache: NonNullable<
    NonNullable<ProjectDependencyRequest['caches']>['analysisCache']
  >,
  request: ProjectDependencyRequest,
) {
  return canPersistCollection(cache, request)
    ? cache
    : coldCollection(cache, request.context.semanticAuthority.family);
}
function canPersistCollection(
  cache: NonNullable<
    NonNullable<ProjectDependencyRequest['caches']>['analysisCache']
  >,
  request: ProjectDependencyRequest,
): boolean {
  const family = request.context.semanticAuthority.family;
  if (family === 'vue')
    return cache.vue.expect(request.context.vueSemanticIdentity);
  // Native context capture filters component roots. Each framework still
  // collects its own mappings, declaration observations and generated inputs.
  return (
    family === 'typescript' ||
    ((request.context.virtualFiles?.size ?? 0) === 0 &&
      request.context.fileNames.some(isNativeTypeScriptProjectInput))
  );
}
function coldCollection(
  cache: NonNullable<
    NonNullable<ProjectDependencyRequest['caches']>['analysisCache']
  >,
  family: string,
): undefined {
  cache.fallback(family);
}

function collectVueDependencies(
  request: ProjectDependencyRequest,
): ProjectDependencyCollection {
  // The compiler collection is synchronous and read-only. Each collection gets
  // fresh bindings. Content reads and independent later fences stay live.
  return new PathBindingReplay({ reuseLeafBindings: true }).run(() => {
    const collection = createEmptyCollection();
    for (const fileName of request.context.fileNames)
      collectProjectDependencyFile({ collection, fileName, request });
    collectSupportContributions(collection, request);
    deduplicateFailures(collection);
    return collection;
  });
}
