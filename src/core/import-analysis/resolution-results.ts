import {
  type ResolvedCheckerModuleName,
  resolveModuleNameWithCheckersDetailed,
} from '#checkers';
import { resolveModuleNameWithOxcCaches } from './oxc-resolution';
import type { ProviderDependencies } from './resolution-provider-types';
import {
  cloneTypeScriptResolution,
  getTypeScriptModuleResolutionCache,
} from './resolver-caches';
import type { NormalizedModuleResolutionRequest } from './types';

function resolveTypeScriptRaw(
  dependencies: ProviderDependencies,
  request: NormalizedModuleResolutionRequest,
): ResolvedCheckerModuleName | null {
  return resolveModuleNameWithCheckersDetailed({
    compilerOptions: request.compilerOptions,
    containingFile: request.containingFile,
    context: request.context,
    metrics: dependencies.metrics,
    moduleResolutionCache: getTypeScriptModuleResolutionCache(
      dependencies.caches,
      {
        compilerOptions: request.compilerOptions,
        context: request.context,
      },
    ),
    specifier: request.specifier,
  });
}

export function resolveTypeScriptResult(
  dependencies: ProviderDependencies,
  request: NormalizedModuleResolutionRequest,
): ResolvedCheckerModuleName | null {
  const hit = request.record.hasTypeScriptResult;
  dependencies.requests.recordIndexAccess('typescript', hit);
  if (!hit) {
    request.record.typeScriptResult = cloneTypeScriptResolution(
      resolveTypeScriptRaw(dependencies, request),
    );
    request.record.hasTypeScriptResult = true;
  }
  return cloneTypeScriptResolution(request.record.typeScriptResult);
}

function resolveOxcRaw(
  dependencies: ProviderDependencies,
  request: NormalizedModuleResolutionRequest,
): string | null {
  return resolveModuleNameWithOxcCaches(dependencies.caches, {
    compilerOptions: request.compilerOptions,
    containingFile: request.containingFile,
    context: request.context,
    metrics: dependencies.metrics,
    specifier: request.specifier,
  });
}

export function resolveOxcResult(
  dependencies: ProviderDependencies,
  request: NormalizedModuleResolutionRequest,
): string | null {
  const hit = request.record.hasOxcResult;
  dependencies.requests.recordIndexAccess('oxc', hit);
  if (!hit) {
    request.record.oxcResult = resolveOxcRaw(dependencies, request);
    request.record.hasOxcResult = true;
  }
  return request.record.oxcResult;
}
