import type {
  AstroConfigClosureEntry,
  CheckerProjectParseContext,
} from '#checkers';
import type { JsonObject } from '#core/tsconfig/actions';
import type ts from 'typescript';

export interface SourceConfigCandidate {
  configObject: JsonObject;
  configPath: string;
  packageRootDir: string;
}

export interface AutoScopeProject {
  svelteOptions?: unknown;
  virtualFiles?: ReadonlyMap<string, string>;
  analysisGeneration: number;
  configPath: string;
  configClosure: AstroConfigClosureEntry[];
  context: CheckerProjectParseContext;
  fileNames: string[];
  options: ts.CompilerOptions;
  packageRootByFileName: Map<string, string>;
  packageRootDir: string;
  references: readonly ts.ProjectReference[];
}
