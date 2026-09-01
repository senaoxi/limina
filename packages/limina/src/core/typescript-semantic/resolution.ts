import type { ResolvedCheckerModuleName } from '#checkers';
import { normalizeAbsolutePath } from '#utils/path';
import type ts from 'typescript';
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
  const raw = options.tsModule.resolveModuleName(
    options.literal.text,
    options.containingFile,
    options.compilerOptions,
    options.host,
    options.moduleResolutionCache,
    options.redirectedReference,
    resolutionMode,
  );
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
  contextIdentity: string;
  importRecord: ImportRecord;
  tsModule: typeof ts;
}): TypeScriptSemanticResolution {
  const resolvedFileName = options.tsModule.resolveTripleslashReference(
    options.importRecord.specifier,
    options.importRecord.filePath,
  );
  const target = options.tsModule.sys.fileExists(resolvedFileName)
    ? toCheckerResolution({
        extension: options.tsModule.Extension.Dts,
        isExternalLibraryImport: false,
        resolvedFileName,
      })
    : null;
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
  const raw = options.tsModule.resolveTypeReferenceDirective(
    options.importRecord.specifier,
    options.containingFile,
    options.compilerOptions,
    options.host,
    options.redirectedReference,
    options.typeReferenceDirectiveResolutionCache,
    options.resolutionMode,
  );
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
