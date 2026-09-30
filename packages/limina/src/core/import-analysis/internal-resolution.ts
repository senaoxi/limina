import type { ResolvedCheckerModuleName } from '#checkers';
import {
  resolveBaseUrlModuleCandidate,
  resolvePathMappedModuleCandidate,
  resolveRelativeModuleCandidate,
} from '#utils/module-resolution';
import type { ProviderDependencies } from './resolution-provider-types';
import {
  resolveOxcResult,
  resolveTypeScriptResult,
} from './resolution-results';
import {
  getResolverExtensions,
  hasTypeScriptOnlyResolutionOptions,
} from './resolver-profile';
import type {
  ImportAnalysisContext,
  ImportAnalysisMetricsRecorder,
  NormalizedModuleResolutionRequest,
} from './types';

function recordInternalResolution(
  metrics: ImportAnalysisMetricsRecorder | undefined,
): void {
  metrics?.record({
    kind: 'request',
    name: 'internal-import-resolution',
    provider: 'import-core',
  });
}

function recordInternalCacheAccess(options: {
  hit: boolean;
  metrics: ImportAnalysisMetricsRecorder | undefined;
}): void {
  options.metrics?.record({
    kind: 'internal-import',
    name: options.hit
      ? 'import-resolution-cache-hit'
      : 'import-resolution-cache-miss',
    provider: 'import-core',
  });
}

function getResolvedFileName(
  resolution: ResolvedCheckerModuleName | null,
): string | null {
  return resolution === null ? null : resolution.resolvedFileName;
}

function resolveTypeScriptPreferred(
  dependencies: ProviderDependencies,
  request: NormalizedModuleResolutionRequest,
): string | null {
  return hasTypeScriptOnlyResolutionOptions(request.compilerOptions)
    ? getResolvedFileName(resolveTypeScriptResult(dependencies, request))
    : null;
}

function resolveLocalCandidate(
  request: NormalizedModuleResolutionRequest,
): string | null {
  const extensions = getResolverExtensions({
    compilerOptions: request.compilerOptions,
    context: request.context,
  });
  return (
    resolveRelativeModuleCandidate({
      containingFile: request.containingFile,
      extensions,
      specifier: request.specifier,
    }) ??
    resolvePathMappedModuleCandidate({
      compilerOptions: request.compilerOptions,
      extensions,
      specifier: request.specifier,
    }) ??
    resolveBaseUrlModuleCandidate({
      compilerOptions: request.compilerOptions,
      extensions,
      specifier: request.specifier,
    })
  );
}

function resolveNonTypeScriptFallback(
  dependencies: ProviderDependencies,
  request: NormalizedModuleResolutionRequest,
): string | null {
  const oxc = resolveOxcResult(dependencies, request);
  return oxc === null
    ? getResolvedFileName(resolveTypeScriptResult(dependencies, request))
    : oxc;
}

function resolveProviderFallback(
  dependencies: ProviderDependencies,
  request: NormalizedModuleResolutionRequest,
): string | null {
  return hasTypeScriptOnlyResolutionOptions(request.compilerOptions)
    ? null
    : resolveNonTypeScriptFallback(dependencies, request);
}

function resolveInternalResult(
  dependencies: ProviderDependencies,
  request: NormalizedModuleResolutionRequest,
): string | null {
  const typeScript = resolveTypeScriptPreferred(dependencies, request);
  if (typeScript !== null) return typeScript;
  const local = resolveLocalCandidate(request);
  return local === null
    ? resolveProviderFallback(dependencies, request)
    : local;
}

function resolveInternalRequest(
  dependencies: ProviderDependencies,
  request: NormalizedModuleResolutionRequest,
): string | null {
  const isHit = request.record.hasInternalImportResult;
  dependencies.requests.recordIndexAccess('internal-import', isHit);
  recordInternalCacheAccess({ hit: isHit, metrics: dependencies.metrics });
  if (isHit) return request.record.internalImportResult;
  const resolved = resolveInternalResult(dependencies, request);
  request.record.internalImportResult = resolved;
  request.record.hasInternalImportResult = true;
  return resolved;
}

export function createInternalResolver(
  dependencies: ProviderDependencies,
): ImportAnalysisContext['resolveInternalImport'] {
  return (...arguments_) => {
    dependencies.requests.recordRequest('internal-import');
    recordInternalResolution(dependencies.metrics);
    return resolveInternalRequest(
      dependencies,
      dependencies.requests.getRequest(...arguments_),
    );
  };
}
