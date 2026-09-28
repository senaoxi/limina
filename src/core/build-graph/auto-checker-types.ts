import type {
  AstroConfigClosureEntry,
  CheckerProjectParseContext,
} from '#checkers';
import type ts from 'typescript';
import type { SourceFilePartition } from './source-capabilities';

export type AutoCheckerPreset = 'tsc' | 'tsgo' | 'vue-tsc';

export interface AutoScopeProject {
  analysisGeneration: number;
  configPath: string;
  configClosure: AstroConfigClosureEntry[];
  context: CheckerProjectParseContext;
  fileNames: string[];
  filePartition: SourceFilePartition;
  options: ts.CompilerOptions;
  packageRootByFileName: Map<string, string>;
  packageRootDir: string;
  references: readonly ts.ProjectReference[];
}
