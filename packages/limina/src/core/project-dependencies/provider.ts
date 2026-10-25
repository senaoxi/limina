import { PathBindingReplay } from '../analysis-cache/directory-fingerprint';
import { managedOutputLookupIdentity } from '../import-graph/managed-output-provider';
import {
  createTypeScriptDependencyContext,
  createTypeScriptProjectDependencyFactsIdentity,
  createTypeScriptSemanticDependencySnapshot,
} from '../typescript-semantic';
import {
  cloneProjectDependencyCollection,
  getProjectSemanticCacheIdentity,
} from './cache';
import type {
  ProjectDependency,
  ProjectDependencyCollection,
  ProjectDependencyObservation,
  ProjectDependencyRequest,
} from './contracts';
import { collectionReferenceInputs } from './declaration-projection';
import { retainNativeObservation } from './native-evidence-retention';
import { collectProjectDependencyFile } from './preparation';
import {
  collectSupportContributions,
  collectVueSupportContributions,
} from './support-contributions';
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
  if (caches.analysisCache !== undefined) return undefined;
  const cached = caches.projectDependencyCache.get(key);
  return cached === undefined
    ? undefined
    : cloneProjectDependencyCollection(cached);
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
  options.request.caches?.projectDependencyCache.set(
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
  return {
    phase: 'locked' as const,
    checker: request.context.analysisChecker ?? 'tsc',
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
  request: ProjectDependencyRequest,
): ProjectDependencyCollection {
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
  cacheCollection({
    cacheKey,
    collection,
    request: semanticRequest,
  });
  return collection;
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
  return (
    family === 'typescript' ||
    (family === 'vue' && cache.vue.expect(request.context.vueSemanticIdentity))
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
  // fresh ancestors; leaf/content observations and later fences stay live.
  return new PathBindingReplay().run(() => {
    const collection = createEmptyCollection();
    for (const fileName of request.context.fileNames)
      collectProjectDependencyFile({ collection, fileName, request });
    collectVueSupportContributions(collection, request);
    deduplicateFailures(collection);
    return collection;
  });
}
