import { isNativeTypeScriptProjectInput } from '#checkers';
import {
  createTypeScriptDependencyContext,
  createTypeScriptProjectDependencyFactsIdentity,
  type TypeScriptSemanticProject,
} from '../typescript-semantic';
import type { NativeRuntimeModuleQuery } from '../typescript-semantic/runtime-module-queries';
import type { ProjectDependencyRequest } from './contracts';
import {
  getProjectSemanticCacheIdentity,
  getWorkspaceSourceBoundarySnapshotIdentity,
} from './identity';
import { retainLiveNativeRuntimeReceipts } from './native-runtime-receipts';

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
  captureRuntimeModuleQuery?: (query: NativeRuntimeModuleQuery) => void,
): ReturnType<typeof createTypeScriptDependencyContext> {
  const project = collectionProject(request);
  const services = collectionServices(request);
  const canRetainLiveQueries =
    captureRuntimeModuleQuery === undefined &&
    services.collectFileDependencyFacts &&
    request.context.semanticAuthority.family === 'typescript' &&
    project.configPath === project.sourceConfigPath;
  let query: NativeRuntimeModuleQuery | undefined;
  let files = services.syntaxFileNames ?? project.fileNames;
  const context = createTypeScriptDependencyContext(project, {
    ...services,
    requireRuntimeModuleQuery: captureRuntimeModuleQuery !== undefined,
    captureRuntimeModuleQuery:
      captureRuntimeModuleQuery ??
      (canRetainLiveQueries
        ? (prepare, isObservedImporter) => {
            query = prepare;
            if (isObservedImporter !== undefined)
              files = files.filter(isObservedImporter);
          }
        : undefined),
  });
  if (query !== undefined)
    retainLiveNativeRuntimeReceipts({
      cache: services.analysisCache,
      context,
      files,
      project,
      query,
    });
  return context;
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
export function collectionProject(
  request: ProjectDependencyRequest,
): TypeScriptSemanticProject {
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
  const shouldCollectRuntimeSyntax =
    request.purpose === 'runtime-source' ||
    caches?.subscriptionPlan?.products.includes('runtime-only') === true;
  const { fileNames, packageRootByFileName } = request.context;
  let syntaxFileNames: readonly string[] | undefined;
  if (shouldCollectRuntimeSyntax)
    syntaxFileNames =
      request.runtimeFileNames ??
      (packageRootByFileName.size === 0
        ? fileNames
        : fileNames.filter((file) => packageRootByFileName.has(file)));
  return {
    analysisCache: persistentCollectionCache(request),
    collectFileDependencyFacts: shouldCollectRuntimeSyntax,
    syntaxFileNames,
    metrics: caches?.metrics,
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
