import type {
  CheckerBuildEngine,
  CheckerProjectConfigCache,
  CheckerProjectParseContext,
} from '#checkers';
import type { ResolvedCheckerConfig } from '#config/runner';
import type { ImportAnalysisContext } from '#core/import-analysis/runner';
import type ts from 'typescript';
import type { LiminaArtifactNamespace } from '../../domain/artifacts/namespace';
import type { ArtifactChange, ArtifactPlan } from '../../domain/artifacts/plan';
import type { CheckerEntrySelection } from '../checkers/entry-selection';
import type {
  ValidatedWorkspaceContext,
  WorkspaceRegionPathIndex,
} from '../workspace/validated-context';
import type {
  GeneratedKnipPackageConfig,
  GeneratedKnipPackageDiagnostic,
} from './generated-knip';
import type { OutputOptions } from './generated/config-readers';

interface GeneratedCheckerManifest {
  configToOutputBuild: Record<string, GeneratedBuildModuleManifest>;
  preset: string;
  entry: string;
  roots: string[];
  sourceToBuild: Record<string, GeneratedBuildModuleManifest>;
  sourceToDts: Record<string, string>;
  dtsToSource: Record<string, string>;
}

interface GeneratedProviderEdgeManifest {
  file: string;
  fromChecker: string;
  fromConfig: string;
  importedSpecifier: string;
  resolvedFile: string;
  toChecker: string;
  toConfig: string;
}

export interface GeneratedProviderEdge {
  file: string;
  fromChecker: string;
  fromConfigPath: string;
  importedSpecifier: string;
  resolvedFilePath: string;
  toChecker: string;
  toConfigPath: string;
}

export type GeneratedBuildModuleKind = 'project' | 'solution';

export interface GeneratedBuildModuleManifest {
  kind: GeneratedBuildModuleKind;
  path: string;
}

export interface GeneratedBuildModule {
  kind: GeneratedBuildModuleKind;
  path: string;
}

export interface GeneratedOutputDeclarationCopyContext {
  fileNames: string[];
  outDir: string;
  rootDir: string;
  sourceConfigPath: string;
}

export interface GeneratedTsconfigGraphManifest {
  version: 3;
  generatedBy: 'limina';
  checkers: Record<string, GeneratedCheckerManifest>;
  knip: {
    diagnostics: GeneratedKnipPackageDiagnostic[];
    packages: GeneratedKnipPackageConfig[];
  };
  ownedArtifacts: string[];
  providerEdges: GeneratedProviderEdgeManifest[];
}

export interface GeneratedTsconfigGraphResult {
  artifactPlan: ArtifactPlan;
  changed: boolean;
  checkers: ResolvedCheckerConfig[];
  manifestPath: string;
  checkerEntries: Map<string, string>;
  configToOutputBuild: Map<string, Map<string, GeneratedBuildModule>>;
  outputDeclarationCopies: Map<
    string,
    Map<string, GeneratedOutputDeclarationCopyContext[]>
  >;
  sourceToBuild: Map<string, Map<string, GeneratedBuildModule>>;
  sourceToDts: Map<string, Map<string, string>>;
  dtsToSource: Map<string, Map<string, string>>;
  generatedKnipConfigs: GeneratedKnipPackageConfig[];
  generatedKnipDiagnostics: GeneratedKnipPackageDiagnostic[];
  providerEdges: GeneratedProviderEdge[];
  manifest: GeneratedTsconfigGraphManifest;
  generatedFiles: ReadonlyMap<string, string>;
}

export interface PrepareGeneratedTsconfigGraphOptions {
  artifactNamespace: LiminaArtifactNamespace;
  importAnalysisContext?: ImportAnalysisContext;
  projectConfigCache?: CheckerProjectConfigCache;
  workspaceContext?: ValidatedWorkspaceContext;
  workspacePathIndex?: WorkspaceRegionPathIndex;
}

export interface SourceProject {
  checkerName: string;
  configPath: string;
  context: CheckerProjectParseContext;
  dtsConfigPath: string;
  fileNames: string[];
  graphRules: string[];
  ownedFileNames: string[];
  outputConfigPath: string;
  outputOptions: OutputOptions | null;
  outputReferences: Set<string>;
  packageRootDir: string;
  options: ts.CompilerOptions;
  references: Set<string>;
}

export interface SolutionProject {
  buildConfigPath: string;
  checkerName: string;
  configPath: string;
  packageRootDir: string;
  references: Set<string>;
}

export interface OutputSolutionProject {
  buildConfigPath: string;
  checkerName: string;
  configPath: string;
  packageRootDir: string;
  references: Set<string>;
}

export interface CheckerSourceConfigCollection {
  buildModulesBySourcePath: Map<string, GeneratedBuildModule>;
  entryConfigPaths: Set<string>;
  projectConfigPaths: Set<string>;
  packageRootBySourcePath: Map<string, string>;
  rootConfigPaths: string[];
  solutionConfigPaths: Set<string>;
  solutionReferencesBySourcePath: Map<string, string[]>;
}

export interface GeneratedGraphWriteContext {
  changes: ArtifactChange[];
  changed: boolean;
  expectedFiles: Set<string>;
  files: Map<string, string>;
  rootDir: string;
}

export interface PreparedCheckerGraph {
  checker: ResolvedCheckerConfig;
  collection: CheckerSourceConfigCollection;
  entryPath: string;
  projects: SourceProject[];
  rootBuildPaths: string[];
  solutions: SolutionProject[];
}

export interface ResolvedCheckerEntrySelection {
  checker: ResolvedCheckerConfig;
  selection: CheckerEntrySelection;
}

export interface CheckerOutputGraph {
  configToOutputBuild: Map<string, GeneratedBuildModule>;
  outputDeclarationCopies: Map<string, GeneratedOutputDeclarationCopyContext[]>;
  outputProjects: SourceProject[];
  outputSolutions: OutputSolutionProject[];
}

export interface InferredProjectReferenceCollection {
  problems: string[];
  providerEdges: GeneratedProviderEdge[];
}

export type ProviderSelectionResult =
  | {
      kind: 'selected';
      project: SourceProject;
      reason: string;
    }
  | {
      candidates: SourceProject[];
      kind: 'missing';
      reason: string;
    }
  | {
      candidates: SourceProject[];
      kind: 'ambiguous';
      reason: string;
    }
  | {
      candidates: SourceProject[];
      kind: 'unsafe-cross-engine';
      reason: string;
    };

export type AutoCheckerPreset = 'tsc' | 'vue-tsc';

export interface AutoScopeProject {
  configPath: string;
  context: CheckerProjectParseContext;
  fileNames: string[];
  options: ts.CompilerOptions;
}

export interface AutoScope {
  collection: CheckerSourceConfigCollection;
  entryConfigPath: string;
  projects: AutoScopeProject[];
}

export interface ProviderEngineGroup {
  engine: CheckerBuildEngine;
  projects: SourceProject[];
}
