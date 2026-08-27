import type { ResolvedCheckerConfig } from '#config/runner';
import type {
  GeneratedKnipPackageConfig,
  GeneratedKnipPackageDiagnostic,
} from './generated-knip';
import type { GeneratedBuildModuleManifest } from './types';

interface GeneratedCheckerManifest {
  configToOutputBuild: Record<string, GeneratedBuildModuleManifest>;
  entry: string;
  name: string;
  roots: string[];
  sourceToBuild: Record<string, GeneratedBuildModuleManifest>;
  sourceToDts: Record<string, string>;
  dtsToSource: Record<string, string>;
}

interface GeneratedConfigOwnershipManifest {
  config: string;
  owner: ResolvedCheckerConfig['name'];
  role: 'solution' | 'type';
}

interface GeneratedSolutionClosureManifest {
  config: string;
  leaves: string[];
  owner: ResolvedCheckerConfig['name'];
}

interface GeneratedBuildTargetManifest {
  checker: ResolvedCheckerConfig['name'];
  entry: string;
  roots: string[];
}

interface GeneratedFrameworkTargetManifest {
  checker: Extract<ResolvedCheckerConfig['name'], 'astro' | 'svelte-check'>;
  config: string;
  packageRoot: string;
}

interface GeneratedDependencyEdgeManifestBase {
  file: string;
  fromChecker: string;
  fromConfig: string;
  importedSpecifier: string;
  resolvedFile: string;
  toChecker: string;
  toConfig: string;
}

interface DeclarationProviderEdgeManifest
  extends GeneratedDependencyEdgeManifestBase {
  cacheReuse: 'non-reusable' | 'reusable';
  kind: 'declaration-provider';
}

interface FrameworkScheduleEdgeManifest
  extends GeneratedDependencyEdgeManifestBase {
  kind: 'framework-schedule';
}

type GeneratedDependencyEdgeManifest =
  | DeclarationProviderEdgeManifest
  | FrameworkScheduleEdgeManifest;

export interface GeneratedTsconfigGraphManifest {
  version: 5;
  generatedBy: 'limina';
  checkers: Record<string, GeneratedCheckerManifest>;
  knip: {
    diagnostics: GeneratedKnipPackageDiagnostic[];
    packages: GeneratedKnipPackageConfig[];
  };
  ownedArtifacts: string[];
  dependencyEdges: GeneratedDependencyEdgeManifest[];
  ownership: {
    configs: GeneratedConfigOwnershipManifest[];
    solutions: GeneratedSolutionClosureManifest[];
  };
  targets: {
    build: GeneratedBuildTargetManifest[];
    framework: GeneratedFrameworkTargetManifest[];
  };
}
