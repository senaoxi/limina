import type {
  AstroConfigClosureEntry,
  AstroSemanticProject,
  CheckerProjectConfigCache,
  CheckerProjectParseContext,
} from '#checkers';
import type { ResolvedCheckerConfig } from '#config/runner';
import type { ImportAnalysisContext } from '#core/import-analysis/runner';
import type ts from 'typescript';
import type { LiminaArtifactNamespace } from '../../domain/artifacts/namespace';
import type { ArtifactChange, ArtifactPlan } from '../../domain/artifacts/plan';
import type { CheckerEntrySelection } from '../checkers/entry-selection';
import type { SvelteSemanticProject } from '../svelte-semantic/types';
import type {
  ValidatedWorkspaceContext,
  WorkspaceRegionPathIndex,
} from '../workspace/validated-context';
import type { AutoScopeProject } from './auto-checker-types';
import type {
  CheckerOwnershipPlan,
  LockedSemanticAuthority,
} from './checker-ownership-types';
import type {
  GeneratedKnipPackageConfig,
  GeneratedKnipPackageDiagnostic,
} from './generated-knip';
import type { OutputOptions } from './generated/config-readers';
import type { GeneratedTsconfigGraphManifest } from './manifest-types';
import type { AutoFrameworkEvidence } from './source-capabilities';

export type { AutoScopeProject } from './auto-checker-types';
export type { GeneratedTsconfigGraphManifest } from './manifest-types';

interface GeneratedDependencyEdgeBase {
  file: string;
  fromChecker: string;
  fromConfigPath: string;
  importedSpecifier: string;
  resolvedFilePath: string;
  toChecker: string;
  toConfigPath: string;
}

export interface DeclarationProviderEdge extends GeneratedDependencyEdgeBase {
  cacheReuse: 'non-reusable' | 'reusable';
  kind: 'declaration-provider';
}

export interface FrameworkScheduleEdge extends GeneratedDependencyEdgeBase {
  kind: 'framework-schedule';
}

export type GeneratedDependencyEdge =
  | DeclarationProviderEdge
  | FrameworkScheduleEdge;

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
  governedSources: Map<string, Map<string, GovernedSourceUnit>>;
  dependencyEdges: GeneratedDependencyEdge[];
  manifest: GeneratedTsconfigGraphManifest;
  ownershipPlan: CheckerOwnershipPlan;
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
  checkerName: ResolvedCheckerConfig['name'];
  configPath: string;
  configClosure: AstroConfigClosureEntry[];
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
  semanticAuthority: LockedSemanticAuthority;
}

export interface FrameworkCapabilityDescriptor {
  family: 'astro' | 'svelte';
  packageRootDir: string;
  sourceConfigPath: string;
}

export type SourceBuildProjection =
  | {
      dtsConfigPath: string;
      kind: 'declaration-project';
    }
  | {
      buildConfigPath: string;
      kind: 'transparent-solution';
    }
  | {
      buildConfigPath: string;
      dtsConfigPath: string;
      kind: 'wrapped-project';
    }
  | {
      kind: 'framework-checker';
    };

export interface GovernedSourceUnit {
  astroSemanticProject?: AstroSemanticProject;
  buildProjection: SourceBuildProjection;
  configPath: string;
  context: CheckerProjectParseContext;
  declarationFileNames: string[];
  declarationReferences: Set<string>;
  frameworkCapabilities: FrameworkCapabilityDescriptor[];
  ownedFileNames: string[];
  packageRootDir: string;
  primaryCheckerName: ResolvedCheckerConfig['name'];
  semanticAuthority: LockedSemanticAuthority;
  svelteSemanticProject?: SvelteSemanticProject;
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
  crossCheckerReferences: CrossCheckerSourceReference[];
  solutionReferencesBySourcePath: Map<string, string[]>;
}

export interface CrossCheckerSourceReference {
  fromConfigPath: string;
  toChecker: ResolvedCheckerConfig['name'];
  toConfigPath: string;
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
  governedSources: GovernedSourceUnit[];
  dependencyEdges: GeneratedDependencyEdge[];
  primaryProjects: SourceProject[];
  projects: SourceProject[];
  rootBuildPaths: string[];
  solutions: SolutionProject[];
}

export interface ResolvedCheckerEntrySelection {
  checker: ResolvedCheckerConfig;
  selection: CheckerEntrySelection;
}

export interface CheckerSelectionResolution {
  ownershipPlan: CheckerOwnershipPlan;
  selections: ResolvedCheckerEntrySelection[];
}

export interface CheckerOutputGraph {
  configToOutputBuild: Map<string, GeneratedBuildModule>;
  outputDeclarationCopies: Map<string, GeneratedOutputDeclarationCopyContext[]>;
  outputProjects: SourceProject[];
  outputSolutions: OutputSolutionProject[];
}

export interface InferredProjectReferenceCollection {
  problems: string[];
  dependencyEdges: GeneratedDependencyEdge[];
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

export interface AutoScope {
  authoritativeChecker?: ResolvedCheckerConfig['name'];
  collection: CheckerSourceConfigCollection;
  entryConfigPath: string;
  frameworkEvidence: AutoFrameworkEvidence[];
  projects: AutoScopeProject[];
}
