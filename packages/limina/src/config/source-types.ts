import type {
  CheckerConfigMode,
  ImportAnalysisConfig,
} from './pipeline-checker-types';

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

export interface SourceKnipCheckConfig {
  workspaces?: Record<string, SourceKnipWorkspaceConfig>;
}

export interface SourceImportAuthorityWorkspaceRootGrant {
  include?: string[];
  reason: string;
  workspaceRootDependencies: string[];
}

export interface SourceImportAuthorityConfig {
  allow?: Record<string, SourceImportAuthorityWorkspaceRootGrant[]>;
}

export interface SourceAmbientDeclarationConfig {
  allowSharedAcrossOwners?: boolean;
  allowTripleSlashReferences?: boolean;
  include: string[];
  reason: string;
}

export interface SourceDeclarationsConfig {
  ambient?: SourceAmbientDeclarationConfig[];
}

export interface SourceCheckConfig {
  declarations?: SourceDeclarationsConfig;
  importAuthority?: SourceImportAuthorityConfig;
  knip?: boolean | SourceKnipCheckConfig;
}

export interface SourceBoundaryConfig {
  exclude?: string[];
  include?: string[];
}

export interface SharedLiminaConfig {
  checkers?: CheckerConfigMode;
  imports?: ImportAnalysisConfig;
  source?: SourceBoundaryConfig;
}
