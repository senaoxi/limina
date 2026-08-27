import {
  cloneProjectDependencyCollection,
  createProjectSemanticCacheIdentity,
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

function deduplicateFailures(collection: ProjectDependencyCollection): void {
  collection.failures = [
    ...new Map(
      collection.failures.map((failure) => [failure.identity, failure]),
    ).values(),
  ];
}

function collectUncachedProjectDependencies(
  request: ProjectDependencyRequest,
): ProjectDependencyCollection {
  const collection = createEmptyCollection();
  for (const fileName of request.context.fileNames) {
    collectProjectDependencyFile({ collection, fileName, request });
  }
  deduplicateFailures(collection);
  return collection;
}

export function collectProjectDependencies(
  request: ProjectDependencyRequest,
): ProjectDependencyCollection {
  const cacheKey = createProjectSemanticCacheIdentity(request.context);
  const cached = getCachedCollection({ cacheKey, request });
  if (cached !== undefined) return cached;
  const collection = collectUncachedProjectDependencies(request);
  cacheCollection({ cacheKey, collection, request });
  return collection;
}

export function projectDependencyCreatesSourceEdge(
  dependency:
    | ProjectDependency
    | Extract<ProjectDependencyObservation, { kind: 'unmapped-generated' }>,
): dependency is ProjectDependency {
  return 'provenance' in dependency;
}
