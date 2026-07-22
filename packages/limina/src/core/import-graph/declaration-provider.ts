import type { CheckerProjectParseContext } from '#checkers';
import type {
  ImportAnalysisContext,
  ImportRecord,
  ResolvedCheckerModuleName,
} from '#core/import-analysis/runner';
import type ts from 'typescript';
import {
  classifyImportRuntimeEvidence,
  type ImportRuntimeResolutionEvidence,
} from '../import-analysis/evidence';
import { isDeclarationFile } from './declaration-classifier';

export interface DeclarationProviderProjectContext
  extends Pick<CheckerProjectParseContext, 'checkerPresets' | 'extensions'> {
  configPath: string;
  resolverConfigPath: string;
}

export type DeclarationProviderResolution =
  | {
      evidence: ImportRuntimeResolutionEvidence & {
        classification: 'resource';
      };
      kind: 'resource';
      oxcResolvedFilePath: string | null;
      typeScriptResolution: ResolvedCheckerModuleName | null;
    }
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

export function isDeclarationFileFamily(filePath: string): boolean {
  return isDeclarationFile(filePath);
}

export function resolveDeclarationProvider(options: {
  compilerOptions: ts.CompilerOptions;
  containingFile: string;
  fileOwnerLookup: Map<string, string[]>;
  importAnalysis: ImportAnalysisContext;
  importRecord: ImportRecord;
  project: DeclarationProviderProjectContext;
}): DeclarationProviderResolution {
  const { oxc: oxcResolvedFilePath, typescript: typeScriptResolution } =
    options.importAnalysis.resolveModulePair(
      options.importRecord.specifier,
      options.containingFile,
      options.compilerOptions,
      options.project,
    );
  const evidence = classifyImportRuntimeEvidence({
    compilerOptions: options.compilerOptions,
    containingFile: options.containingFile,
    extensions: options.project.extensions,
    oxcResolvedFilePath,
    specifier: options.importRecord.specifier,
    typeScriptResolution,
  });

  if (evidence.classification === 'resource') {
    return {
      evidence: {
        ...evidence,
        classification: 'resource',
      },
      kind: 'resource',
      oxcResolvedFilePath,
      typeScriptResolution,
    };
  }

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
