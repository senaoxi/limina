import type { CheckerProjectParseContext } from '#checkers';
import type {
  ImportAnalysisContext,
  ImportRecord,
  ResolvedCheckerModuleName,
} from '#core/import-analysis/runner';
import type ts from 'typescript';

export interface DeclarationProviderProjectContext
  extends Pick<CheckerProjectParseContext, 'checkerPresets' | 'extensions'> {
  configPath: string;
  resolverConfigPath: string;
}

export type DeclarationProviderResolution =
  | {
      kind: 'declaration';
      oxcResolvedFilePath: string | null;
      typeScriptResolution: ResolvedCheckerModuleName;
    }
  | {
      kind: 'source';
      ownerProjectPaths: string[];
      oxcResolvedFilePath: string | null;
      typeScriptResolution: ResolvedCheckerModuleName;
    }
  | {
      kind: 'oxc-only';
      oxcResolvedFilePath: string;
      typeScriptResolution: null;
    }
  | {
      kind: 'unresolved';
      oxcResolvedFilePath: null;
      typeScriptResolution: null;
    };

const declarationFileFamilyPattern = /\.d\.(?:cts|mts|ts)$/u;

export function isDeclarationFileFamily(filePath: string): boolean {
  return declarationFileFamilyPattern.test(filePath);
}

export function resolveDeclarationProvider(options: {
  compilerOptions: ts.CompilerOptions;
  containingFile: string;
  fileOwnerLookup: Map<string, string[]>;
  importAnalysis: ImportAnalysisContext;
  importRecord: ImportRecord;
  project: DeclarationProviderProjectContext;
}): DeclarationProviderResolution {
  const typeScriptResolution = options.importAnalysis.resolveTypeScriptImport(
    options.importRecord.specifier,
    options.containingFile,
    options.compilerOptions,
    options.project,
  );
  const oxcResolvedFilePath = options.importAnalysis.resolveOxcImport(
    options.importRecord.specifier,
    options.containingFile,
    options.compilerOptions,
    options.project,
  );

  if (!typeScriptResolution) {
    return oxcResolvedFilePath
      ? {
          kind: 'oxc-only',
          oxcResolvedFilePath,
          typeScriptResolution: null,
        }
      : {
          kind: 'unresolved',
          oxcResolvedFilePath: null,
          typeScriptResolution: null,
        };
  }

  if (isDeclarationFileFamily(typeScriptResolution.resolvedFileName)) {
    return {
      kind: 'declaration',
      oxcResolvedFilePath,
      typeScriptResolution,
    };
  }

  return {
    kind: 'source',
    ownerProjectPaths:
      options.fileOwnerLookup.get(typeScriptResolution.resolvedFileName) ?? [],
    oxcResolvedFilePath,
    typeScriptResolution,
  };
}
