import type { ResolvedCheckerModuleName } from '#checkers';
import { normalizeAbsolutePath } from '#utils/path';
import type ts from 'typescript';
import type { NativeAnalysisCache } from '../analysis-cache/native-cache';
import type { ImportRecord } from '../import-analysis/records';
import type {
  TypeScriptSemanticChannel,
  TypeScriptSemanticResolution,
} from './contracts';
import {
  createRedirectedReferenceIdentity,
  createTypeScriptResolutionIdentity,
} from './identity';

function toCheckerResolution(
  resolved: ts.ResolvedModuleFull | undefined,
): ResolvedCheckerModuleName | null {
  if (resolved === undefined) return null;
  return {
    isExternalLibraryImport: resolved.isExternalLibraryImport === true,
    resolvedBy: 'typescript',
    resolvedFileName: normalizeAbsolutePath(resolved.resolvedFileName),
  };
}

function createResolution(options: {
  channel: TypeScriptSemanticChannel;
  contextIdentity: string;
  importRecord: ImportRecord;
  redirectedReference: ts.ResolvedProjectReference | undefined;
  resolutionMode: ts.ResolutionMode | undefined;
  target: ResolvedCheckerModuleName | null;
}): TypeScriptSemanticResolution {
  const redirectedReferenceIdentity = createRedirectedReferenceIdentity(
    options.redirectedReference,
  );
  return {
    channel: options.channel,
    identity: createTypeScriptResolutionIdentity({
      contextIdentity: options.contextIdentity,
      importRecord: options.importRecord,
      redirectedReferenceIdentity,
      resolutionMode: options.resolutionMode,
    }),
    redirectedReferenceIdentity,
    resolutionMode: options.resolutionMode,
    target: options.target,
  };
}

export function createMissingSemanticResolution(options: {
  channel: TypeScriptSemanticChannel;
  contextIdentity: string;
  importRecord: ImportRecord;
}): TypeScriptSemanticResolution {
  return createResolution({
    ...options,
    redirectedReference: undefined,
    resolutionMode: undefined,
    target: null,
  });
}

export function resolveModuleSemanticRecord(options: {
  analysisCache?: NativeAnalysisCache;
  analysisContextId?: string;
  channel?: 'jsx-runtime' | 'module';
  compilerOptions: ts.CompilerOptions;
  containingFile: string;
  contextIdentity: string;
  host: ts.ModuleResolutionHost;
  importRecord: ImportRecord;
  literal: ts.StringLiteralLike;
  moduleResolutionCache: ts.ModuleResolutionCache;
  redirectedReference: ts.ResolvedProjectReference | undefined;
  sourceFile: ts.SourceFile;
  tsModule: typeof ts;
}): {
  raw: ts.ResolvedModuleWithFailedLookupLocations;
  semantic: TypeScriptSemanticResolution;
} {
  const resolutionMode = options.tsModule.getModeForUsageLocation(
    options.sourceFile,
    options.literal,
    options.compilerOptions,
  );
  const resolve = (host: ts.ModuleResolutionHost) =>
    options.tsModule.resolveModuleName(
      options.literal.text,
      options.containingFile,
      options.compilerOptions,
      host,
      options.analysisCache === undefined
        ? options.moduleResolutionCache
        : undefined,
      options.redirectedReference,
      resolutionMode,
    );
  const raw = cachedResolution({ options, resolutionMode, resolve });
  return {
    raw,
    semantic: createResolution({
      channel: options.channel ?? 'module',
      contextIdentity: options.contextIdentity,
      importRecord: options.importRecord,
      redirectedReference: options.redirectedReference,
      resolutionMode,
      target: toCheckerResolution(raw.resolvedModule),
    }),
  };
}

export function resolveTripleSlashPathSemanticRecord(options: {
  analysisCache?: NativeAnalysisCache;
  analysisContextId?: string;
  contextIdentity: string;
  importRecord: ImportRecord;
  tsModule: typeof ts;
}): TypeScriptSemanticResolution {
  const resolvedFileName = options.tsModule.resolveTripleslashReference(
    options.importRecord.specifier,
    options.importRecord.filePath,
  );
  const resolve = (host: ts.ModuleResolutionHost) => ({
    resolvedModule: host.fileExists(resolvedFileName)
      ? {
          extension: options.tsModule.Extension.Dts,
          isExternalLibraryImport: false,
          resolvedFileName,
        }
      : undefined,
    failedLookupLocations: [resolvedFileName],
    affectingLocations: undefined,
  });
  const raw = cachedResolution({
    options: {
      ...options,
      containingFile: options.importRecord.filePath,
      host: options.tsModule.sys,
      redirectedReference: undefined,
    },
    resolutionMode: undefined,
    resolve,
  });
  const target = toCheckerResolution(raw.resolvedModule);
  return createResolution({
    channel: 'triple-slash-path',
    contextIdentity: options.contextIdentity,
    importRecord: options.importRecord,
    redirectedReference: undefined,
    resolutionMode: undefined,
    target,
  });
}

export function resolveTypeReferenceSemanticRecord(options: {
  analysisCache?: NativeAnalysisCache;
  analysisContextId?: string;
  compilerOptions: ts.CompilerOptions;
  containingFile: string;
  contextIdentity: string;
  host: ts.ModuleResolutionHost;
  importRecord: ImportRecord;
  redirectedReference: ts.ResolvedProjectReference | undefined;
  resolutionMode: ts.ResolutionMode | undefined;
  tsModule: typeof ts;
  typeReferenceDirectiveResolutionCache: ts.TypeReferenceDirectiveResolutionCache;
}): {
  raw: ts.ResolvedTypeReferenceDirectiveWithFailedLookupLocations;
  semantic: TypeScriptSemanticResolution;
} {
  const resolve = (host: ts.ModuleResolutionHost) =>
    options.tsModule.resolveTypeReferenceDirective(
      options.importRecord.specifier,
      options.containingFile,
      options.compilerOptions,
      host,
      options.redirectedReference,
      options.analysisCache === undefined
        ? options.typeReferenceDirectiveResolutionCache
        : undefined,
      options.resolutionMode,
    );
  const raw = cachedResolution({
    options,
    resolutionMode: options.resolutionMode,
    resolve,
  });
  const resolved = raw.resolvedTypeReferenceDirective;
  const target =
    resolved?.resolvedFileName === undefined
      ? null
      : {
          isExternalLibraryImport: resolved.isExternalLibraryImport === true,
          resolvedBy: 'typescript' as const,
          resolvedFileName: normalizeAbsolutePath(resolved.resolvedFileName),
        };
  return {
    raw,
    semantic: createResolution({
      channel: 'triple-slash-types',
      contextIdentity: options.contextIdentity,
      importRecord: options.importRecord,
      redirectedReference: options.redirectedReference,
      resolutionMode: options.resolutionMode,
      target,
    }),
  };
}

function cachedResolution<T>(input: {
  options: {
    analysisCache?: NativeAnalysisCache;
    analysisContextId?: string;
    containingFile: string;
    compilerOptions?: ts.CompilerOptions;
    importRecord: ImportRecord;
    host: ts.ModuleResolutionHost;
    redirectedReference: ts.ResolvedProjectReference | undefined;
  };
  resolutionMode: ts.ResolutionMode | undefined;
  resolve(host: ts.ModuleResolutionHost): T;
}): T {
  const { options } = input;
  if (options.analysisCache === undefined) return input.resolve(options.host);
  return options.analysisCache.query({
    contextId: options.analysisContextId!,
    file: options.containingFile,
    identity: [
      options.compilerOptions,
      options.importRecord.kind,
      options.importRecord.specifier,
      input.resolutionMode,
      createRedirectedReferenceIdentity(options.redirectedReference),
      options.redirectedReference?.commandLine.options,
    ],
    host: options.host,
    resolve: input.resolve,
  });
}
