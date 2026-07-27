import {
  type ResolvedCheckerModuleName,
  resolveModuleNameWithCheckersDetailed,
} from '#checkers';
import {
  resolveBaseUrlModuleCandidate,
  resolvePathMappedModuleCandidate,
  resolveRelativeModuleCandidate,
} from '#utils/module-resolution';
import { resolveModuleNameWithOxcCaches } from './oxc-resolution';
import type { ModuleResolutionRequestIndex } from './request-index';
import {
  cloneTypeScriptResolution,
  getTypeScriptModuleResolutionCache,
} from './resolver-caches';
import {
  getResolverExtensions,
  hasTypeScriptOnlyResolutionOptions,
} from './resolver-profile';
import type {
  ImportAnalysisCaches,
  ImportAnalysisContext,
  ImportAnalysisMetricsRecorder,
  ImportResolutionArguments,
  ModuleResolutionPair,
  NormalizedModuleResolutionRequest,
} from './types';

type ResolutionProvider = Pick<
  ImportAnalysisContext,
  | 'resolveInternalImport'
  | 'resolveModulePair'
  | 'resolveOxcImport'
  | 'resolveTypeScriptImport'
>;

interface ProviderDependencies {
  caches: ImportAnalysisCaches;
  metrics: ImportAnalysisMetricsRecorder | undefined;
  requests: ModuleResolutionRequestIndex;
}

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

function resolveTypeScriptResult(
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

function resolveOxcResult(
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

function getRequest(
  dependencies: ProviderDependencies,
  args: ImportResolutionArguments,
): NormalizedModuleResolutionRequest {
  return dependencies.requests.getRequest(...args);
}

function createTypeScriptResolver(
  dependencies: ProviderDependencies,
): ImportAnalysisContext['resolveTypeScriptImport'] {
  return (...args) => {
    dependencies.requests.recordRequest('typescript');
    return resolveTypeScriptResult(
      dependencies,
      getRequest(dependencies, args),
    );
  };
}

function createOxcResolver(
  dependencies: ProviderDependencies,
): ImportAnalysisContext['resolveOxcImport'] {
  return (...args) => {
    dependencies.requests.recordRequest('oxc');
    return resolveOxcResult(dependencies, getRequest(dependencies, args));
  };
}

function createPairResolver(
  dependencies: ProviderDependencies,
): ImportAnalysisContext['resolveModulePair'] {
  return (...args): ModuleResolutionPair => {
    const request = getRequest(dependencies, args);
    dependencies.requests.recordRequest('typescript');
    const typescript = resolveTypeScriptResult(dependencies, request);
    dependencies.requests.recordRequest('oxc');
    const oxc = resolveOxcResult(dependencies, request);
    return { oxc, typescript };
  };
}

function createInternalResolver(
  dependencies: ProviderDependencies,
): ImportAnalysisContext['resolveInternalImport'] {
  return (...args) => {
    dependencies.requests.recordRequest('internal-import');
    recordInternalResolution(dependencies.metrics);
    return resolveInternalRequest(dependencies, getRequest(dependencies, args));
  };
}

export function createResolutionProvider(
  dependencies: ProviderDependencies,
): ResolutionProvider {
  return {
    resolveInternalImport: createInternalResolver(dependencies),
    resolveModulePair: createPairResolver(dependencies),
    resolveOxcImport: createOxcResolver(dependencies),
    resolveTypeScriptImport: createTypeScriptResolver(dependencies),
  };
}
