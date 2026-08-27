import { createFrameworkSemanticFailure } from '../framework-semantic/contracts';
import { resolveSvelteSemanticImport } from '../svelte-semantic/resolution';
import { resolveAstroSemanticPair } from './astro-pair-resolution';
import { cloneCheckerResolutionEvidence } from './checker-resolution-clone';
import type { ImportRecord } from './records';
import type { ProviderDependencies } from './resolution-provider-types';
import { resolveTypeScriptResult } from './resolution-results';
import { classifyImportRuntimeEvidence } from './runtime-evidence';
import { classifyAstroSemanticEligibility } from './semantic-eligibility';
import type {
  CanonicalImportResolutionEvidence,
  ImportAnalysisContext,
  ModuleResolutionPair,
  NormalizedModuleResolutionRequest,
} from './types';
import { resolveVueSemanticPair } from './vue-pair-resolution';

const TYPESCRIPT_SUB_SEMANTIC_KINDS = new Set<ImportRecord['kind']>([
  'environment-pragma',
  'jsx-import-source',
  'triple-slash-path',
  'triple-slash-types',
]);

function createCacheKey(options: {
  importRecord: ImportRecord;
  request: NormalizedModuleResolutionRequest;
}): string {
  return JSON.stringify({
    containingFile: options.request.containingFile,
    domain: options.importRecord.domain,
    kind: options.importRecord.kind,
    locator: options.importRecord.locator,
    resolverIdentity: options.request.resolverIdentity,
    semanticFamily: options.request.context.semanticFamily ?? 'typescript',
    specifier: options.importRecord.specifier,
  });
}

function resolveTypeScriptPair(options: {
  dependencies: ProviderDependencies;
  request: NormalizedModuleResolutionRequest;
}): ModuleResolutionPair {
  options.dependencies.requests.recordRequest('typescript');
  return {
    oxc: null,
    typescript: resolveTypeScriptResult(options.dependencies, options.request),
  };
}

function createMissingContextPair(options: {
  framework: 'astro' | 'svelte' | 'vue';
  reason: string;
  request: NormalizedModuleResolutionRequest;
}): ModuleResolutionPair {
  return {
    oxc: null,
    semanticFailure: createFrameworkSemanticFailure({
      framework: options.framework,
      reason: options.reason,
      scopeIdentity:
        options.request.context.configPath ?? options.request.containingFile,
      stage: 'context-creation',
    }),
    typescript: null,
  };
}

function resolveVuePair(options: {
  dependencies: ProviderDependencies;
  importRecord: ImportRecord;
  request: NormalizedModuleResolutionRequest;
}): ModuleResolutionPair {
  const identity = options.request.context.vueSemanticIdentity;
  if (identity === undefined) {
    return createMissingContextPair({
      framework: 'vue',
      reason:
        'Locked Vue semantic authority has no Vue project semantic identity.',
      request: options.request,
    });
  }
  if (TYPESCRIPT_SUB_SEMANTIC_KINDS.has(options.importRecord.kind)) {
    return resolveTypeScriptPair(options);
  }
  options.dependencies.requests.recordRequest('typescript');
  return resolveVueSemanticPair({
    identity,
    importRecord: options.importRecord,
    manager: options.dependencies.vueSemanticContexts,
    oxc: null,
  });
}

function resolveAstroPair(options: {
  dependencies: ProviderDependencies;
  importRecord: ImportRecord;
  request: NormalizedModuleResolutionRequest;
}): ModuleResolutionPair {
  if (TYPESCRIPT_SUB_SEMANTIC_KINDS.has(options.importRecord.kind)) {
    return resolveTypeScriptPair(options);
  }
  const project = options.request.context.astroSemanticProject;
  if (project === undefined) {
    return createMissingContextPair({
      framework: 'astro',
      reason: 'Locked Astro semantic authority has no Astro semantic project.',
      request: options.request,
    });
  }
  return resolveMaterializedAstroPair(options);
}

function resolveMaterializedAstroPair(options: {
  dependencies: ProviderDependencies;
  importRecord: ImportRecord;
  request: NormalizedModuleResolutionRequest;
}): ModuleResolutionPair {
  const project = options.request.context.astroSemanticProject!;
  const eligibility = classifyAstroSemanticEligibility({
    checkerExtensions: options.request.context.extensions,
    importRecord: options.importRecord,
    oxcResolvedFilePath: null,
    project,
    specifier: options.importRecord.specifier,
  });
  if (eligibility.kind !== 'eligible') {
    return resolveTypeScriptPair(options);
  }
  options.dependencies.requests.recordRequest('typescript');
  return resolveAstroSemanticPair({
    dependencies: options.dependencies,
    importRecord: options.importRecord,
    oxc: null,
    request: options.request,
  });
}

interface SveltePairOptions {
  dependencies: ProviderDependencies;
  importRecord: ImportRecord;
  request: NormalizedModuleResolutionRequest;
}

function getSvelteSemanticContext(options: SveltePairOptions) {
  const project = options.request.context.svelteSemanticProject;
  if (project === undefined) return null;
  const manager = options.dependencies.svelteSemanticContexts;
  if (manager === undefined) return null;
  return { manager, project };
}

function createSveltePair(options: {
  importRecord: ImportRecord;
  manager: NonNullable<ProviderDependencies['svelteSemanticContexts']>;
  project: NonNullable<
    NormalizedModuleResolutionRequest['context']['svelteSemanticProject']
  >;
}): ModuleResolutionPair {
  const semantic = resolveSvelteSemanticImport(options);
  if (semantic.kind === 'unsupported') {
    return {
      oxc: null,
      semanticFailure: createFrameworkSemanticFailure({
        framework: 'svelte',
        reason: semantic.reason,
        scopeIdentity: options.project.configPath,
        stage: semantic.stage,
      }),
      typescript: null,
    };
  }
  return {
    oxc: null,
    semanticEvidence: {
      framework: 'svelte',
      identityId: options.project.configPath,
      provenance: semantic.fact.provenance,
      resolutionMode: semantic.fact.resolutionMode,
      semanticSpecifier: semantic.fact.semanticSpecifier,
      sourceRecord: semantic.fact.importRecord,
      target: semantic.fact.target,
    },
    typescript: semantic.fact.target,
  };
}

function resolveSveltePair(options: SveltePairOptions): ModuleResolutionPair {
  if (TYPESCRIPT_SUB_SEMANTIC_KINDS.has(options.importRecord.kind)) {
    return resolveTypeScriptPair(options);
  }
  if (!options.importRecord.filePath.toLowerCase().endsWith('.svelte')) {
    return resolveTypeScriptPair(options);
  }
  return resolveMaterializedSveltePair(options);
}

function resolveMaterializedSveltePair(
  options: SveltePairOptions,
): ModuleResolutionPair {
  const context = getSvelteSemanticContext(options);
  if (context === null) {
    return createMissingContextPair({
      framework: 'svelte',
      reason:
        'Locked Svelte semantic authority has no materialized Svelte TypeScript adapter.',
      request: options.request,
    });
  }
  return createSveltePair({ ...context, importRecord: options.importRecord });
}

interface CheckerPairOptions {
  dependencies: ProviderDependencies;
  importRecord: ImportRecord;
  request: NormalizedModuleResolutionRequest;
}

const CHECKER_PAIR_RESOLVERS = {
  astro: resolveAstroPair,
  svelte: resolveSveltePair,
  typescript: resolveTypeScriptPair,
  vue: resolveVuePair,
} satisfies Record<
  NonNullable<NormalizedModuleResolutionRequest['context']['semanticFamily']>,
  (options: CheckerPairOptions) => ModuleResolutionPair
>;

function resolveCheckerPair(options: CheckerPairOptions): ModuleResolutionPair {
  const family = options.request.context.semanticFamily ?? 'typescript';
  return CHECKER_PAIR_RESOLVERS[family](options);
}

function createEvidence(options: {
  dependencies: ProviderDependencies;
  importRecord: ImportRecord;
  request: NormalizedModuleResolutionRequest;
}): CanonicalImportResolutionEvidence {
  const pair = resolveCheckerPair(options);
  return {
    eligibility: {
      kind: 'not-applicable',
      reason: 'Resolution is governed by a locked checker semantic context.',
    },
    oxcResolvedFilePath: null,
    runtimeEvidence: classifyImportRuntimeEvidence({
      compilerOptions: options.request.compilerOptions,
      containingFile: options.request.containingFile,
      extensions: options.request.context.extensions,
      oxcResolvedFilePath: null,
      specifier: options.importRecord.specifier,
      typeScriptResolution: pair.typescript,
    }),
    semanticEvidence: pair.semanticEvidence,
    semanticFailure: pair.semanticFailure,
    typeScriptResolution: pair.typescript,
  };
}

export function createCheckerSemanticResolver(
  dependencies: ProviderDependencies,
): ImportAnalysisContext['resolveCheckerImportEvidence'] {
  return (...args) => {
    const [importRecord, containingFile, compilerOptions, context] = args;
    const request = dependencies.requests.getRequest(
      importRecord.specifier,
      containingFile,
      compilerOptions,
      context,
    );
    const cacheKey = createCacheKey({ importRecord, request });
    const cached = dependencies.caches.checkerResolutionIndex.get(cacheKey);
    if (cached !== undefined) return cloneCheckerResolutionEvidence(cached);
    const evidence = createEvidence({ dependencies, importRecord, request });
    dependencies.caches.checkerResolutionIndex.set(cacheKey, evidence);
    return cloneCheckerResolutionEvidence(evidence);
  };
}
