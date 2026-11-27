import type {
  ProjectDependencyCollection,
  ProjectDependencyRequest,
} from './contracts';
import { getProjectSemanticCacheIdentity } from './identity';
import { collectProjectDependencyFile } from './preparation';
import { lookupSharedNativeContext, nativeConfigContextKey } from './provider';
import { RuntimeSourceResolver } from './runtime-source-resolution';

function getSharedRuntimeResolver(
  input: Pick<ProjectDependencyRequest, 'caches' | 'context'>,
): RuntimeSourceResolver | undefined {
  if (input.context.semanticAuthority.family !== 'typescript') {
    return undefined;
  }
  const resolvers = input.caches?.runtimeSourceResolvers;
  const key = `${nativeConfigContextKey(input.context)}:${JSON.stringify(input.context.extensions)}`;
  const existing = resolvers?.get(key);
  if (existing !== undefined) return existing;
  const resolver = new RuntimeSourceResolver(
    input.context,
    input.caches?.analysisCache,
  );
  resolvers?.set(key, resolver);
  return resolver;
}

/**
 * Runtime/source observations reuse locked Native compiler evidence when
 * available and fall back to RuntimeSourceResolver ONLY for runtime-only
 * occurrences absent from the compiler's request inventory (such as
 * require.resolve / createRequire / TS require). They confer no compilation
 * obligation and never enter the Native evidence or reference projection.
 */
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
  const request: ProjectDependencyRequest = {
    ...input,
    purpose: 'runtime-source',
    typeScriptSemanticContext: sharedNativeContext,
    runtimeSourceResolver: getSharedRuntimeResolver(input),
  };
  const semanticRequest = {
    ...request,
    projectSemanticCacheIdentity: getProjectSemanticCacheIdentity(request),
  };
  for (const fileName of request.context.fileNames)
    collectProjectDependencyFile({
      collection,
      fileName,
      request: semanticRequest,
    });
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
