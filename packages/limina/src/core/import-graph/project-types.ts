import type { CheckerProjectParseContext } from '#checkers';
import type ts from 'typescript';

export interface ProjectInfo {
  checkerPresets: CheckerProjectParseContext['checkerPresets'];
  configPath: string;
  extensions: string[];
  fileNames: string[];
  labels: string[];
  labelDiagnostic?: ProjectGraphLabelDiagnostic | null;
  labelProblem: string | null;
  ownedFileNames: string[];
  options: ts.CompilerOptions;
  references: Set<string>;
  resolverConfigPath: string;
}

export interface ProjectGraphLabelDiagnostic {
  readonly detailLines: readonly string[];
  readonly field: string;
  readonly projectPath: string;
  readonly reason: string;
  readonly title: string;
  readonly value?: unknown;
}

export type ProjectGraphRuleInfo = Pick<
  ProjectInfo,
  'labelDiagnostic' | 'labels' | 'labelProblem'
>;
