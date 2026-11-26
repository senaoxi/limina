import { isNativeTypeScriptProjectInput } from '#checkers';
import {
  createTypeScriptDependencyContext,
  createTypeScriptProjectDependencyFactsIdentity,
} from '../typescript-semantic';
import type { ProjectDependencyRequest } from './contracts';
import {
  getProjectSemanticCacheIdentity,
  getWorkspaceSourceBoundarySnapshotIdentity,
} from './identity';

export function projectDependencyFactsKey(
  request: ProjectDependencyRequest,
): string {
  return JSON.stringify([
    getProjectSemanticCacheIdentity(request),
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
}

export function createCollectionContext(
  request: ProjectDependencyRequest,
): ReturnType<typeof createTypeScriptDependencyContext> {
  return createTypeScriptDependencyContext(
    collectionProject(request),
    collectionServices(request),
  );
}

export function restoreCollectionContext(
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
