import type { ResolvedCheckerModuleName } from '#checkers';
import type ts from 'typescript';
import type { NativeEvidenceSnapshot } from '../../domain/analysis/native-evidence';
import type { ImportRecord } from '../import-analysis/records';
import type { DeclarationEntry } from './declaration-closure';
import type { NativeDependencyFact } from './dependency-fact';
import type { NativeContextInventory } from './native-context-inventory';
import type { WorkspaceSourceBoundary } from './workspace-source-boundary';

export type TypeScriptSemanticChannel =
  | 'environment-pragma'
  | 'jsx-runtime'
  | 'lib-environment'
  | 'module'
  | 'triple-slash-path'
  | 'triple-slash-types';

export type TypeScriptSemanticAdmissionMode =
  | 'full-program'
  | 'root-facts'
  | 'coverage-bounded';

export interface TypeScriptSemanticProject {
  compilationObligationScope?: 'generated-declaration-project-v1';
  analysisBinding?: { phase: 'pending' | 'locked'; checker: string };
  virtualFiles?: ReadonlyMap<string, string>;
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
  readonly nativeEvidence?: NativeEvidenceSnapshot;
  readonly nativeInventory?: NativeContextInventory;
  getTypeEnvironmentEntries?(): readonly DeclarationEntry[];
  getContributionFileNames?(): readonly string[];
  getDependencyFact(importRecord: ImportRecord): NativeDependencyFact;
  getImportRecords(fileName: string): readonly ImportRecord[];
  hasSourceFile(fileName: string): boolean;
  getCollectedDependencyFacts?(): ReadonlyMap<string, NativeDependencyFact>;
}

export interface TypeScriptSemanticContext
  extends TypeScriptSemanticDependencyContext {
  readonly program: ts.Program;
  getCollectedDependencyFacts?(): ReadonlyMap<string, NativeDependencyFact>;
  dispose(): void;
  getSourceFile(fileName: string): ts.SourceFile | undefined;
  getSymbolAtImportRecord(importRecord: ImportRecord): ts.Symbol | undefined;
}
