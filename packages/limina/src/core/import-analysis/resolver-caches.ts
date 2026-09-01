import type { ResolvedCheckerModuleName } from '#checkers';
import type { ResolverFactory } from 'oxc-resolver';
import ts from 'typescript';
import { getResolverExtensions } from './resolver-profile';
import type {
  ImportAnalysisCaches,
  LazyModuleResolutionRecord,
  ResolvedImportContext,
} from './types';

export function createImportAnalysisCaches(): ImportAnalysisCaches {
  return {
    importsCache: new Map(),
    importsPromiseCache: new Map(),
    canonicalResolutionIndex: new Map(),
    checkerResolutionIndex: new Map(),
    moduleResolutionIndex: new Map(),
    moduleResolverIdentityCache: new Map(),
    nextModuleResolverIdentity: 0,
    resolverCache: new Map<string, ResolverFactory>(),
    sourceTextCache: new Map(),
    typeScriptModuleResolutionCache: new Map(),
  };
}

function optionalString(value: string | undefined): string | null {
  if (value === undefined) return null;
  return value;
}

function getVueSemanticIdentityId(
  context: ResolvedImportContext,
): string | null {
  const identity = context.vueSemanticIdentity;
  if (identity === undefined) return null;
  return identity.id;
}

function getAstroSemanticIdentityId(
  context: ResolvedImportContext,
): string | null {
  return context.astroSemanticProject?.seed.id ?? null;
}

function getSvelteSemanticIdentityId(
  context: ResolvedImportContext,
): string | null {
  const project = context.svelteSemanticProject;
  if (project === undefined) return null;
  return JSON.stringify({
    adapterVersion: project.adapterVersion,
    configPath: project.configPath,
    generation: project.generation,
    packageRootDir: project.packageRootDir,
  });
}

function createTypeScriptModuleResolutionCacheKey(options: {
  compilerOptions: ts.CompilerOptions;
  context: ResolvedImportContext;
}): string {
  return JSON.stringify({
    astroSemanticIdentity: getAstroSemanticIdentityId(options.context),
    compilerOptions: options.compilerOptions,
    configPath: optionalString(options.context.configPath),
    extensions: getResolverExtensions(options),
    resolverConfigPath: optionalString(options.context.resolverConfigPath),
    semanticFamily: optionalString(options.context.semanticFamily),
    svelteSemanticIdentity: getSvelteSemanticIdentityId(options.context),
    typeScriptSemanticIdentity:
      options.context.typeScriptSemanticContext?.identity ?? null,
    vueSemanticIdentity: getVueSemanticIdentityId(options.context),
  });
}

function createResolverIdentityKey(options: {
  compilerOptions: ts.CompilerOptions;
  context: ResolvedImportContext;
}): string {
  return JSON.stringify({
    astroSemanticIdentity: getAstroSemanticIdentityId(options.context),
    checkerPresets: options.context.checkerPresets,
    compilerOptions: options.compilerOptions,
    configPath: optionalString(options.context.configPath),
    extensions: getResolverExtensions(options),
    resolverConfigPath: optionalString(options.context.resolverConfigPath),
    semanticFamily: optionalString(options.context.semanticFamily),
    svelteSemanticIdentity: getSvelteSemanticIdentityId(options.context),
    typeScriptSemanticIdentity:
      options.context.typeScriptSemanticContext?.identity ?? null,
    vueSemanticIdentity: getVueSemanticIdentityId(options.context),
  });
}

export function getModuleResolverIdentity(
  caches: ImportAnalysisCaches,
  options: {
    compilerOptions: ts.CompilerOptions;
    context: ResolvedImportContext;
  },
): number {
  const cacheKey = createResolverIdentityKey(options);
  const cached = caches.moduleResolverIdentityCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const identity = caches.nextModuleResolverIdentity;
  caches.nextModuleResolverIdentity += 1;
  caches.moduleResolverIdentityCache.set(cacheKey, identity);
  return identity;
}

export function createModuleResolutionRequestKey(options: {
  containingFile: string;
  resolverIdentity: number;
  specifier: string;
}): string {
  return JSON.stringify(options);
}

export function createLazyModuleResolutionRecord(): LazyModuleResolutionRecord {
  return {
    hasInternalImportResult: false,
    hasOxcResult: false,
    hasTypeScriptResult: false,
    internalImportResult: null,
    oxcResult: null,
    typeScriptResult: null,
  };
}

export function cloneTypeScriptResolution(
  resolution: ResolvedCheckerModuleName | null,
): ResolvedCheckerModuleName | null {
  if (resolution === null) return null;
  return { ...resolution };
}

function createCanonicalFileName(fileName: string): string {
  if (ts.sys.useCaseSensitiveFileNames) return fileName;
  return fileName.toLowerCase();
}

export function getTypeScriptModuleResolutionCache(
  caches: ImportAnalysisCaches,
  options: {
    compilerOptions: ts.CompilerOptions;
    context: ResolvedImportContext;
  },
): ts.ModuleResolutionCache {
  const cacheKey = createTypeScriptModuleResolutionCacheKey(options);
  const cached = caches.typeScriptModuleResolutionCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const cache = ts.createModuleResolutionCache(
    ts.sys.getCurrentDirectory(),
    createCanonicalFileName,
    options.compilerOptions,
  );
  caches.typeScriptModuleResolutionCache.set(cacheKey, cache);
  return cache;
}

export function clearOxcResolverCaches(caches: ImportAnalysisCaches): void {
  for (const resolver of caches.resolverCache.values()) resolver.clearCache();
}
