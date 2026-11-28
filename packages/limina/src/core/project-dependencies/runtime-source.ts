import type {
  ProjectDependencyCollection,
  ProjectDependencyRequest,
} from './contracts';
import { getProjectSemanticCacheIdentity } from './identity';
import { collectProjectDependencyFile } from './preparation';
import {
  lookupSharedNativeContext,
  nativeConfigContextKey,
  registerNativeConfigContext,
  withDeclarationLoading,
} from './provider';
import { RuntimeSourceResolver } from './runtime-source-resolution';

function getSharedRuntimeResolver(
  input: ProjectDependencyRequest,
): RuntimeSourceResolver | undefined {
  if (input.context.semanticAuthority.family !== 'typescript') {
    return undefined;
  }
  const resolvers = input.caches?.runtimeSourceResolvers;
  const key = JSON.stringify([
    nativeConfigContextKey(input.context),
    input.context.extensions,
    input.runtimeFileNames,
  ]);
  const existing = resolvers?.get(key);
  if (existing !== undefined) return existing;
  const resolver = new RuntimeSourceResolver(input);
  resolvers?.set(key, resolver);
  return resolver;
}

export function collectRuntimeProjectDependencies(
  input: Omit<
    ProjectDependencyRequest,
    | 'purpose'
    | 'compilationObligationScope'
    | 'typeScriptSemanticContext'
    | 'projectSemanticCacheIdentity'
    | 'runtimeSourceResolver'
  >,
): ProjectDependencyCollection {
  const collection: ProjectDependencyCollection = {
    dependencies: [],
    failures: [],
    observations: [],
  };
  const sharedNativeContext = lookupSharedNativeContext(input) ?? undefined;
  const runtimeFileNames = input.runtimeFileNames ?? input.context.fileNames;
  const request = withDeclarationLoading({
    ...input,
    purpose: 'runtime-source',
    runtimeFileNames,
  });
  const resolver = getSharedRuntimeResolver(request);
  try {
    const native = resolver?.getNativeContext(sharedNativeContext);
    if (native !== undefined && sharedNativeContext === undefined)
      registerNativeConfigContext(request, native);
    const semanticRequest = {
      ...request,
      typeScriptSemanticContext: native,
      runtimeSourceResolver: resolver,
      projectSemanticCacheIdentity: getProjectSemanticCacheIdentity(request),
    };
    for (const fileName of runtimeFileNames)
      collectProjectDependencyFile({
        collection,
        fileName,
        request: semanticRequest,
      });
  } finally {
    resolver?.releaseProgram();
  }
  return {
    dependencies: collection.dependencies.map((dependency) => ({
      ...dependency,
      referenceRequirement: null,
    })),
    observations: collection.observations,
    failures: collection.failures,
    referenceInputs: [],
  };
}
