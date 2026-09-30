import type { FrameworkSemanticFailure } from '../framework-semantic/contracts';
import { resolveAstroSemanticPair } from './astro-pair-resolution';
import type { ImportRecord } from './records';
import type { ProviderDependencies } from './resolution-provider-types';
import {
  resolveOxcResult,
  resolveTypeScriptResult,
} from './resolution-results';
import { cloneTypeScriptResolution } from './resolver-caches';
import { classifyImportRuntimeEvidence } from './runtime-evidence';
import {
  classifyAstroSemanticEligibility,
  type SemanticEligibility,
} from './semantic-eligibility';
import type {
  CanonicalImportResolutionEvidence,
  ImportAnalysisContext,
  ImportAnalysisMetricsRecorder,
  ModuleResolutionPair,
  NormalizedModuleResolutionRequest,
} from './types';
import {
  resolveVueSemanticPair,
  shouldUseVueSemanticResolution,
} from './vue-pair-resolution';

function nullableString(value: string | undefined): string | null {
  return value === undefined ? null : value;
}

function getAstroContextIdentity(
  request: NormalizedModuleResolutionRequest,
): string | null {
  const project = request.context.astroSemanticProject;
  return project === undefined ? null : project.seed.id;
}

function getVueContextIdentity(
  request: NormalizedModuleResolutionRequest,
): string | null {
  const identity = request.context.vueSemanticIdentity;
  return identity === undefined ? null : identity.id;
}

function createCanonicalCacheKey(options: {
  importRecord: ImportRecord;
  request: NormalizedModuleResolutionRequest;
}): string {
  return JSON.stringify({
    containingFile: options.request.containingFile,
    context: {
      astro: getAstroContextIdentity(options.request),
      configPath: nullableString(options.request.context.configPath),
      resolverConfigPath: nullableString(
        options.request.context.resolverConfigPath,
      ),
      vue: getVueContextIdentity(options.request),
    },
    domain: options.importRecord.domain,
    kind: options.importRecord.kind,
    locator: options.importRecord.locator,
    resolverIdentity: options.request.resolverIdentity,
    specifier: options.importRecord.specifier,
  });
}

function cloneFrameworkFailure(
  failure: FrameworkSemanticFailure | undefined,
): FrameworkSemanticFailure | undefined {
  return failure === undefined ? undefined : { ...failure };
}

function cloneCanonicalEvidence(
  evidence: CanonicalImportResolutionEvidence,
): CanonicalImportResolutionEvidence {
  return {
    eligibility: { ...evidence.eligibility },
    oxcResolvedFilePath: evidence.oxcResolvedFilePath,
    runtimeEvidence: {
      ...evidence.runtimeEvidence,
      runtime: { ...evidence.runtimeEvidence.runtime },
    },
    semanticEvidence:
      evidence.semanticEvidence === undefined
        ? undefined
        : {
            ...evidence.semanticEvidence,
            sourceRecord: {
              ...evidence.semanticEvidence.sourceRecord,
              locator: { ...evidence.semanticEvidence.sourceRecord.locator },
            },
            target:
              evidence.semanticEvidence.target === null
                ? null
                : { ...evidence.semanticEvidence.target },
          },
    semanticFailure: cloneFrameworkFailure(evidence.semanticFailure),
    typeScriptResolution: cloneTypeScriptResolution(
      evidence.typeScriptResolution,
    ),
  };
}

function recordAstroSemanticCache(options: {
  hit: boolean;
  metrics: ImportAnalysisMetricsRecorder | undefined;
}): void {
  options.metrics?.record({
    name: options.hit
      ? 'astro-semantic-cache-hit'
      : 'astro-semantic-cache-miss',
    provider: 'astro-semantic',
  });
}

function resolveNonAstroPair(options: {
  dependencies: ProviderDependencies;
  importRecord: ImportRecord;
  oxc: string | null;
  request: NormalizedModuleResolutionRequest;
}): ModuleResolutionPair {
  options.dependencies.requests.recordRequest('typescript');
  if (!shouldUseVueSemanticResolution(options)) {
    const semanticContext = options.request.context.typeScriptSemanticContext;
    return {
      oxc: options.oxc,
      typescript:
        semanticContext === undefined
          ? resolveTypeScriptResult(options.dependencies, options.request)
          : semanticContext.resolveImportRecord(options.importRecord).target,
    };
  }
  return resolveVueSemanticPair({
    identity: options.request.context.vueSemanticIdentity!,
    importRecord: options.importRecord,
    manager: options.dependencies.vueSemanticContexts,
    oxc: options.oxc,
  });
}

function recordEligibleCacheAccess(options: {
  eligibility: SemanticEligibility;
  hit: boolean;
  metrics: ImportAnalysisMetricsRecorder | undefined;
}): void {
  if (options.eligibility.kind !== 'eligible') return;
  recordAstroSemanticCache(options);
}

function readCanonicalCache(options: {
  cacheKey: string;
  dependencies: ProviderDependencies;
}): CanonicalImportResolutionEvidence | null {
  const cached = options.dependencies.caches.canonicalResolutionIndex.get(
    options.cacheKey,
  );
  if (cached === undefined) return null;
  recordEligibleCacheAccess({
    eligibility: cached.eligibility,
    hit: true,
    metrics: options.dependencies.metrics,
  });
  return cloneCanonicalEvidence(cached);
}

function resolveEligiblePair(options: {
  dependencies: ProviderDependencies;
  eligibility: SemanticEligibility;
  importRecord: ImportRecord;
  oxc: string | null;
  request: NormalizedModuleResolutionRequest;
}): ModuleResolutionPair {
  return options.eligibility.kind === 'eligible'
    ? resolveAstroSemanticPair(options)
    : resolveNonAstroPair(options);
}

function createCanonicalEvidence(options: {
  dependencies: ProviderDependencies;
  importRecord: ImportRecord;
  request: NormalizedModuleResolutionRequest;
}): CanonicalImportResolutionEvidence {
  options.dependencies.requests.recordRequest('oxc');
  const oxc = resolveOxcResult(options.dependencies, options.request);
  const eligibility = classifyAstroSemanticEligibility({
    checkerExtensions: options.request.context.extensions,
    importRecord: options.importRecord,
    oxcResolvedFilePath: oxc,
    project: options.request.context.astroSemanticProject,
    specifier: options.importRecord.specifier,
  });
  recordEligibleCacheAccess({
    eligibility,
    hit: false,
    metrics: options.dependencies.metrics,
  });
  const pair = resolveEligiblePair({ ...options, eligibility, oxc });
  return {
    eligibility,
    oxcResolvedFilePath: oxc,
    runtimeEvidence: classifyImportRuntimeEvidence({
      compilerOptions: options.request.compilerOptions,
      containingFile: options.request.containingFile,
      extensions: options.request.context.extensions,
      oxcResolvedFilePath: oxc,
      specifier: options.importRecord.specifier,
      typeScriptResolution: pair.typescript,
    }),
    semanticEvidence: pair.semanticEvidence,
    semanticFailure: pair.semanticFailure,
    typeScriptResolution: pair.typescript,
  };
}

export function createCanonicalResolver(
  dependencies: ProviderDependencies,
): ImportAnalysisContext['resolveImportEvidence'] {
  return (...arguments_) => {
    const [importRecord, containingFile, compilerOptions, context] = arguments_;
    const request = dependencies.requests.getRequest(
      importRecord.specifier,
      containingFile,
      compilerOptions,
      context,
    );
    const cacheKey = createCanonicalCacheKey({ importRecord, request });
    const cached = readCanonicalCache({ cacheKey, dependencies });
    if (cached !== null) return cached;
    const evidence = createCanonicalEvidence({
      dependencies,
      importRecord,
      request,
    });
    dependencies.caches.canonicalResolutionIndex.set(cacheKey, evidence);
    return cloneCanonicalEvidence(evidence);
  };
}
