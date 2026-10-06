import {
  createBoundedTypeScriptSemanticContext,
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
import { collectProjectDependencyFile } from './preparation';

function createEmptyCollection(): ProjectDependencyCollection {
  return { dependencies: [], failures: [], observations: [] };
}

function getCachedCollection(options: {
  cacheKey: string;
  request: ProjectDependencyRequest;
}): ProjectDependencyCollection | undefined {
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
  return createBoundedTypeScriptSemanticContext(
    {
      analysisBinding: {
        phase: 'locked',
        checker: request.context.analysisChecker ?? 'tsc',
      },
      configPath: request.context.configPath,
      fileNames: request.context.fileNames,
      options: request.context.compilerOptions,
      projectReferences: request.context.references,
      virtualFiles: request.context.virtualFiles,
      workspaceSourceBoundary: request.context.workspaceSourceBoundary,
    },
    {
      ...collectionServices(request),
    },
  );
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
  typeScriptSemanticContext: NonNullable<
    ProjectDependencyRequest['typeScriptSemanticContext']
  >;
}): ProjectDependencyCollection {
  const collection = createEmptyCollection();
  const request = {
    ...options.request,
    typeScriptSemanticContext: options.typeScriptSemanticContext,
  };
  for (const fileName of request.context.fileNames) {
    collectProjectDependencyFile({ collection, fileName, request });
  }
  deduplicateFailures(collection);
  return collection;
}

function collectUncachedProjectDependencies(options: {
  factsCacheKey: string;
  request: ProjectDependencyRequest;
}): ProjectDependencyCollection {
  const cachedContext =
    options.request.caches?.typeScriptSemanticFactsCache.get(
      options.factsCacheKey,
    );
  if (cachedContext === undefined) {
    return collectProjectDependenciesWithNewContext(options);
  }
  return collectProjectDependenciesWithContext({
    request: options.request,
    typeScriptSemanticContext: cachedContext,
  });
}

export function collectProjectDependencies(
  request: ProjectDependencyRequest,
): ProjectDependencyCollection {
  const projectSemanticIdentity = getProjectSemanticCacheIdentity(request);
  const cacheKey = projectSemanticIdentity;
  const cached = getCachedCollection({ cacheKey, request });
  if (cached !== undefined) return cached;
  const semanticRequest = {
    ...request,
    projectSemanticCacheIdentity: projectSemanticIdentity,
  };
  const factsCacheKey = JSON.stringify([
    projectSemanticIdentity,
    createTypeScriptProjectDependencyFactsIdentity({
      configPath: request.context.configPath,
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
    syntaxFacts: caches.syntaxFacts,
    analysisCache: nativeCache(
      caches,
      request.context.semanticAuthority.family,
    ),
  };
}

function nativeCache(
  caches: NonNullable<ProjectDependencyRequest['caches']>,
  family: string,
) {
  if (family !== 'typescript') recordColdProvider(caches, family);
  return family === 'typescript' ? caches.analysisCache : undefined;
}

function recordColdProvider(
  caches: NonNullable<ProjectDependencyRequest['caches']>,
  family: string,
): void {
  caches.analysisCache?.fallback(family);
}
