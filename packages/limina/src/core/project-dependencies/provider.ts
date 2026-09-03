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
  const cached = options.request.caches?.projectDependencyCache.get(
    options.cacheKey,
  );
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

function hasUnidentifiedWorkspaceExportPolicy(
  request: ProjectDependencyRequest,
): boolean {
  return (
    request.resolveWorkspaceTypeScriptExport !== undefined &&
    request.workspaceTypeScriptExportCacheIdentity === undefined
  );
}

function createCollectionCacheKey(options: {
  projectSemanticIdentity: string;
  request: ProjectDependencyRequest;
}): string | undefined {
  if (hasUnidentifiedWorkspaceExportPolicy(options.request)) return undefined;
  return JSON.stringify({
    project: options.projectSemanticIdentity,
    workspaceTypeScriptExport:
      options.request.workspaceTypeScriptExportCacheIdentity ?? null,
  });
}

function getCachedCollectionIfEnabled(options: {
  cacheKey: string | undefined;
  request: ProjectDependencyRequest;
}): ProjectDependencyCollection | undefined {
  if (options.cacheKey === undefined) return undefined;
  return getCachedCollection({
    cacheKey: options.cacheKey,
    request: options.request,
  });
}

function cacheCollectionIfEnabled(options: {
  cacheKey: string | undefined;
  collection: ProjectDependencyCollection;
  request: ProjectDependencyRequest;
}): void {
  if (options.cacheKey === undefined) return;
  cacheCollection({
    cacheKey: options.cacheKey,
    collection: options.collection,
    request: options.request,
  });
}

function deduplicateFailures(collection: ProjectDependencyCollection): void {
  collection.failures = [
    ...new Map(
      collection.failures.map((failure) => [failure.identity, failure]),
    ).values(),
  ];
}

function collectProjectDependenciesWithNewContext(options: {
  factsCacheKey: string;
  request: ProjectDependencyRequest;
}): ProjectDependencyCollection {
  const collection = createEmptyCollection();
  const typeScriptSemanticContext = createBoundedTypeScriptSemanticContext(
    {
      configPath: options.request.context.configPath,
      fileNames: options.request.context.fileNames,
      options: options.request.context.compilerOptions,
      projectReferences: options.request.context.references,
      workspaceSourceBoundary: options.request.context.workspaceSourceBoundary,
    },
    { dependencyFactsOnly: true },
  );
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
  const cacheKey = createCollectionCacheKey({
    projectSemanticIdentity,
    request,
  });
  const cached = getCachedCollectionIfEnabled({ cacheKey, request });
  if (cached !== undefined) return cached;
  const semanticRequest = {
    ...request,
    projectSemanticCacheIdentity: projectSemanticIdentity,
  };
  const factsCacheKey = createTypeScriptProjectDependencyFactsIdentity({
    configPath: request.context.configPath,
    fileNames: request.context.fileNames,
    options: request.context.compilerOptions,
    projectReferences: request.context.references,
    workspaceSourceBoundary: request.context.workspaceSourceBoundary,
  });
  const collection = collectUncachedProjectDependencies({
    factsCacheKey,
    request: semanticRequest,
  });
  cacheCollectionIfEnabled({
    cacheKey,
    collection,
    request: semanticRequest,
  });
  return collection;
}

export function projectDependencyCreatesSourceEdge(
  dependency:
    | ProjectDependency
    | Extract<ProjectDependencyObservation, { kind: 'unmapped-generated' }>,
): dependency is ProjectDependency {
  return 'provenance' in dependency;
}
