import type { ResolvedLiminaConfig } from '#config/runner';
import type { WorkspacePackage } from '#core/workspace/actions';
import type { PackageOwnerIdentity } from '../../core/workspace/owner-identity';
import type { ValidatedWorkspaceContext } from '../../core/workspace/validated-context';

export interface KnipUnusedWorkspaceDependencyIssue {
  ownerIdentity: PackageOwnerIdentity;
  dependencyName: string;
  externalCode: 'dependencies' | 'devDependencies' | 'optionalPeerDependencies';
  packageJsonPath: string;
}

export interface KnipUnusedSourceFileIssue {
  externalCode: 'files';
  filePath: string;
}

export interface KnipOwnerProject {
  directory: string;
  entryFiles: string[];
  ignoreFiles: string[];
  projectFiles: string[];
  virtualEntrySourceFiles: string[];
}

export interface KnipSourceIssues {
  unusedSourceFiles: KnipUnusedSourceFileIssue[];
  unusedWorkspaceDependencies: KnipUnusedWorkspaceDependencyIssue[];
}

export interface KnipSourceAnalysisGroup {
  tsConfigFile?: string;
  workspaceNames?: string[];
}

export type KnipSourceIssueType = 'dependencies' | 'files';

export interface KnipCliInvocation {
  configPath: string;
  include: KnipSourceIssueType[];
  rootDir: string;
  tsConfigFile?: string;
  workspaceNames?: string[];
}

export type KnipCliRunner = (options: KnipCliInvocation) => Promise<string>;

export interface KnipWorkspaceConfig {
  [key: string]: unknown;
  entry?: string[];
  ignoreDependencies?: string[];
  ignoreFiles?: string[];
  project?: string[];
}

export interface KnipConfig extends KnipWorkspaceConfig {
  $schema: string;
  workspaces?: Record<string, KnipWorkspaceConfig>;
}

export interface CollectKnipSourceIssuesOptions {
  analysisGroups?: KnipSourceAnalysisGroup[];
  config: ResolvedLiminaConfig;
  ignoredKeys: Set<string>;
  includeFiles: boolean;
  knipRunner?: KnipCliRunner;
  ownerProjects: KnipOwnerProject[];
  workspacePackages: WorkspacePackage[];
  workspaceContext: ValidatedWorkspaceContext;
}
