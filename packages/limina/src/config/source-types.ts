export interface SourceKnipIgnoredDependencyConfig {
  dep: string;
  reason: string;
}

export interface SourceKnipIgnoredFileConfig {
  file: string;
  reason: string;
}

export interface SourceKnipEntryConfig {
  files: string[];
  reason: string;
}

export interface SourceKnipWorkspaceConfig {
  entry?: SourceKnipEntryConfig[];
  ignoreDependencies?: SourceKnipIgnoredDependencyConfig[];
  ignoreFiles?: SourceKnipIgnoredFileConfig[];
}

interface SourceKnipOptions {
  root?: SourceKnipWorkspaceConfig;
  workspaces?: Record<string, SourceKnipWorkspaceConfig>;
}

export type SourceKnipCheckConfig = SourceKnipOptions &
  (
    | { root: SourceKnipWorkspaceConfig }
    | { workspaces: Record<string, SourceKnipWorkspaceConfig> }
  );

export interface SourceImportAuthorityWorkspaceRootGrant {
  include?: string[];
  reason: string;
  workspaceRootDependencies: string[];
}

export interface SourceImportAuthorityConfig {
  allow: Record<string, SourceImportAuthorityWorkspaceRootGrant[]>;
}

interface SourceCheckOptions {
  forbidCrossPackageRelativeImports?: boolean;
  importAuthority?: SourceImportAuthorityConfig;
  knip?: boolean | SourceKnipCheckConfig;
}

export type SourceCheckConfig = SourceCheckOptions &
  (
    | { forbidCrossPackageRelativeImports: boolean }
    | { importAuthority: SourceImportAuthorityConfig }
    | { knip: boolean | SourceKnipCheckConfig }
  );

export interface SourceBoundaryConfig {
  exclude?: string[];
  include?: string[];
}
