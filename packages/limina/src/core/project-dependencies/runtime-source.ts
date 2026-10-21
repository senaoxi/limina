import type {
  ProjectDependencyCollection,
  ProjectDependencyRequest,
} from './contracts';
import { collectProjectDependencyFile } from './preparation';
import { RuntimeSourceResolver } from './runtime-source-resolution';

/**
 * Runtime/source observations use the source parser, including runtime calls
 * absent from the compiler's request inventory. They confer no compilation
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
  const request: ProjectDependencyRequest = {
    ...input,
    purpose: 'runtime-source',
    runtimeSourceResolver:
      input.context.semanticAuthority.family === 'typescript'
        ? new RuntimeSourceResolver(input.context)
        : undefined,
  };
  for (const fileName of request.context.fileNames)
    collectProjectDependencyFile({ collection, fileName, request });
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
