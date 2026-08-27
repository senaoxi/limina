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
  if (resolution === null) return null;
  return resolution.resolvedFileName;
}

function resolveTypeScriptPreferred(
  dependencies: ProviderDependencies,
  request: NormalizedModuleResolutionRequest,
): string | null {
  if (!hasTypeScriptOnlyResolutionOptions(request.compilerOptions)) return null;
  return getResolvedFileName(resolveTypeScriptResult(dependencies, request));
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
  if (oxc !== null) return oxc;
  return getResolvedFileName(resolveTypeScriptResult(dependencies, request));
}

function resolveProviderFallback(
  dependencies: ProviderDependencies,
  request: NormalizedModuleResolutionRequest,
): string | null {
  if (hasTypeScriptOnlyResolutionOptions(request.compilerOptions)) return null;
  return resolveNonTypeScriptFallback(dependencies, request);
}

function resolveInternalResult(
  dependencies: ProviderDependencies,
  request: NormalizedModuleResolutionRequest,
): string | null {
  const typeScript = resolveTypeScriptPreferred(dependencies, request);
  if (typeScript !== null) return typeScript;
  const local = resolveLocalCandidate(request);
  if (local !== null) return local;
  return resolveProviderFallback(dependencies, request);
}

function resolveInternalRequest(
  dependencies: ProviderDependencies,
  request: NormalizedModuleResolutionRequest,
): string | null {
  const hit = request.record.hasInternalImportResult;
  dependencies.requests.recordIndexAccess('internal-import', hit);
  recordInternalCacheAccess({ hit, metrics: dependencies.metrics });
  if (hit) return request.record.internalImportResult;
  const resolved = resolveInternalResult(dependencies, request);
  request.record.internalImportResult = resolved;
  request.record.hasInternalImportResult = true;
  return resolved;
}

export function createInternalResolver(
  dependencies: ProviderDependencies,
): ImportAnalysisContext['resolveInternalImport'] {
  return (...args) => {
    dependencies.requests.recordRequest('internal-import');
    recordInternalResolution(dependencies.metrics);
    return resolveInternalRequest(
      dependencies,
      dependencies.requests.getRequest(...args),
    );
  };
}
