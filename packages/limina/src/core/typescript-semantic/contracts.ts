import type { ResolvedCheckerModuleName } from '#checkers';
import type ts from 'typescript';
import type { ImportRecord } from '../import-analysis/records';
import type { WorkspaceSourceBoundary } from './workspace-source-boundary';

export type TypeScriptSemanticChannel =
  | 'environment-pragma'
  | 'jsx-runtime'
  | 'lib-environment'
  | 'module'
  | 'triple-slash-path'
  | 'triple-slash-types';

export type TypeScriptSemanticAdmissionMode = 'full-program' | 'root-facts';

export interface TypeScriptSemanticProject {
  admissionMode?: TypeScriptSemanticAdmissionMode;
  configPath: string;
  fileNames: readonly string[];
  options: ts.CompilerOptions;
  projectReferences?: readonly ts.ProjectReference[];
  workspaceSourceBoundary: WorkspaceSourceBoundary;
}

export interface TypeScriptSemanticResolution {
  channel: TypeScriptSemanticChannel;
  identity: string;
  redirectedReferenceIdentity: string | null;
  resolutionMode: ts.ResolutionMode | undefined;
  target: ResolvedCheckerModuleName | null;
}

export interface TypeScriptSemanticResolutionContext {
  readonly identity: string;
  resolveImportRecord(importRecord: ImportRecord): TypeScriptSemanticResolution;
}

export interface TypeScriptSemanticDependencyContext
  extends TypeScriptSemanticResolutionContext {
  getImportRecords(fileName: string): readonly ImportRecord[];
  hasSourceFile(fileName: string): boolean;
}

export interface TypeScriptSemanticContext
  extends TypeScriptSemanticDependencyContext {
  readonly program: ts.Program;
  dispose(): void;
  getSourceFile(fileName: string): ts.SourceFile | undefined;
  getSymbolAtImportRecord(importRecord: ImportRecord): ts.Symbol | undefined;
}
