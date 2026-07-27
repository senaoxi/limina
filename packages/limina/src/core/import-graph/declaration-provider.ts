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

function isResourceEvidence(
  evidence: ImportRuntimeResolutionEvidence,
): evidence is ImportRuntimeResolutionEvidence & {
  classification: 'resource';
} {
  return evidence.classification === 'resource';
}

function createResourceResolution(options: {
  evidence: ImportRuntimeResolutionEvidence & { classification: 'resource' };
  oxcResolvedFilePath: string | null;
  typeScriptResolution: ResolvedCheckerModuleName | null;
}): DeclarationProviderResolution {
  return {
    evidence: options.evidence,
    kind: 'resource',
    oxcResolvedFilePath: options.oxcResolvedFilePath,
    typeScriptResolution: options.typeScriptResolution,
  };
}

function createMissingTypeScriptResolution(
  oxcResolvedFilePath: string | null,
): DeclarationProviderResolution {
  return oxcResolvedFilePath === null
    ? {
        kind: 'unresolved',
        oxcResolvedFilePath: null,
        typeScriptResolution: null,
      }
    : {
        kind: 'oxc-only',
        oxcResolvedFilePath,
        typeScriptResolution: null,
      };
}

function createTypeScriptResolution(options: {
  fileOwnerLookup: Map<string, string[]>;
  oxcResolvedFilePath: string | null;
  typeScriptResolution: ResolvedCheckerModuleName;
}): DeclarationProviderResolution {
  if (isDeclarationFileFamily(options.typeScriptResolution.resolvedFileName)) {
    return {
      kind: 'declaration',
      oxcResolvedFilePath: options.oxcResolvedFilePath,
      typeScriptResolution: options.typeScriptResolution,
    };
  }

  return {
    kind: 'source',
    ownerProjectPaths:
      options.fileOwnerLookup.get(
        options.typeScriptResolution.resolvedFileName,
      ) ?? [],
    oxcResolvedFilePath: options.oxcResolvedFilePath,
    typeScriptResolution: options.typeScriptResolution,
  };
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

  if (isResourceEvidence(evidence)) {
    return createResourceResolution({
      evidence,
      oxcResolvedFilePath,
      typeScriptResolution,
    });
  }

  if (typeScriptResolution === null) {
    return createMissingTypeScriptResolution(oxcResolvedFilePath);
  }

  return createTypeScriptResolution({
    fileOwnerLookup: options.fileOwnerLookup,
    oxcResolvedFilePath,
    typeScriptResolution,
  });
}
