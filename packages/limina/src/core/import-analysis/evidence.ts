import type { ResolvedCheckerModuleName } from '#checkers';
import type ts from 'typescript';
import type { TypeEvidence } from '../type-evidence/cache';

export type ImportModuleClassification =
  | 'checker-source'
  | 'resource'
  | 'ordinary-module';

export type RuntimeEvidence =
  | {
      authority: 'filesystem' | 'oxc' | 'package-export';
      baseOnly?: boolean;
      filePath: string;
      kind: 'file';
    }
  | {
      assertionId: string;
      kind: 'asserted-virtual';
    }
  | {
      checkedPath?: string;
      kind: 'missing';
    }
  | {
      kind: 'unsupported';
      reason: string;
    };

export interface ImportRuntimeResolutionEvidence {
  classification: ImportModuleClassification;
  runtime: RuntimeEvidence;
}

export interface ImportResolutionEvidence
  extends ImportRuntimeResolutionEvidence {
  type: TypeEvidence;
}

export interface ClassifyImportRuntimeEvidenceOptions {
  compilerOptions: ts.CompilerOptions;
  containingFile: string;
  extensions: readonly string[];
  oxcResolvedFilePath: string | null;
  specifier: string;
  typeScriptResolution: ResolvedCheckerModuleName | null;
}

export { classifyImportRuntimeEvidence } from './runtime-evidence';
