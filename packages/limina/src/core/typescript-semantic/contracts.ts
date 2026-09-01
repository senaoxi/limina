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

export interface TypeScriptSemanticProject {
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

export interface TypeScriptSemanticContext {
  readonly identity: string;
  readonly program: ts.Program;
  dispose(): void;
  getImportRecords(fileName: string): readonly ImportRecord[];
  getSourceFile(fileName: string): ts.SourceFile | undefined;
  getSymbolAtImportRecord(importRecord: ImportRecord): ts.Symbol | undefined;
  resolveImportRecord(importRecord: ImportRecord): TypeScriptSemanticResolution;
}
