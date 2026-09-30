import { createCanonicalResolver } from './canonical-resolution-provider';
import { createCheckerDependencyPreparation } from './checker-dependency-preparation';
import { createCheckerSemanticResolver } from './checker-resolution-provider';
import { createInternalResolver } from './internal-resolution';
import type {
  ProviderDependencies,
  ResolutionProvider,
} from './resolution-provider-types';
import {
  resolveOxcResult,
  resolveTypeScriptResult,
} from './resolution-results';
import type {
  ImportAnalysisContext,
  ImportResolutionArguments,
  ModuleResolutionPair,
  NormalizedModuleResolutionRequest,
} from './types';

function getRequest(
  dependencies: ProviderDependencies,
  arguments_: ImportResolutionArguments,
): NormalizedModuleResolutionRequest {
  return dependencies.requests.getRequest(...arguments_);
}

function createTypeScriptResolver(
  dependencies: ProviderDependencies,
): ImportAnalysisContext['resolveTypeScriptImport'] {
  return (...arguments_) => {
    dependencies.requests.recordRequest('typescript');
    return resolveTypeScriptResult(
      dependencies,
      getRequest(dependencies, arguments_),
    );
  };
}

function createOxcResolver(
  dependencies: ProviderDependencies,
): ImportAnalysisContext['resolveOxcImport'] {
  return (...arguments_) => {
    dependencies.requests.recordRequest('oxc');
    return resolveOxcResult(dependencies, getRequest(dependencies, arguments_));
  };
}

function createPairResolver(
  dependencies: ProviderDependencies,
): ImportAnalysisContext['resolveModulePair'] {
  return (...arguments_): ModuleResolutionPair => {
    const request = getRequest(dependencies, arguments_);
    dependencies.requests.recordRequest('typescript');
    const typescript = resolveTypeScriptResult(dependencies, request);
    dependencies.requests.recordRequest('oxc');
    const oxc = resolveOxcResult(dependencies, request);
    return { oxc, typescript };
  };
}

export function createResolutionProvider(
  dependencies: ProviderDependencies,
): ResolutionProvider {
  return {
    prepareCheckerSemanticDependencies:
      createCheckerDependencyPreparation(dependencies),
    resolveCheckerImportEvidence: createCheckerSemanticResolver(dependencies),
    resolveInternalImport: createInternalResolver(dependencies),
    resolveImportEvidence: createCanonicalResolver(dependencies),
    resolveModulePair: createPairResolver(dependencies),
    resolveOxcImport: createOxcResolver(dependencies),
    resolveTypeScriptImport: createTypeScriptResolver(dependencies),
  };
}
