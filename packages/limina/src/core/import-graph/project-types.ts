import type {
  AstroConfigClosureEntry,
  AstroSemanticProject,
  CheckerProjectParseContext,
  VueProjectSemanticIdentity,
} from '#checkers';
import type ts from 'typescript';
import type { LockedSemanticAuthority } from '../build-graph/checker-ownership-types';
import type { SvelteSemanticProject } from '../svelte-semantic/types';

export interface ProjectInfo {
  analysisGeneration: number;
  astroSemanticProject?: AstroSemanticProject;
  checkerPresets: CheckerProjectParseContext['checkerPresets'];
  configClosure: AstroConfigClosureEntry[];
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
  semanticAuthority?: LockedSemanticAuthority;
  svelteSemanticProject?: SvelteSemanticProject;
  vueSemanticIdentity?: VueProjectSemanticIdentity;
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
