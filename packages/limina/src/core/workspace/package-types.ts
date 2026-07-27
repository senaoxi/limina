export interface PackageManifest {
  bin?: Record<string, string> | string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  exports?: unknown;
  imports?: Record<string, unknown>;
  name?: string;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  private?: boolean;
  scripts?: Record<string, string>;
  types?: string;
  typings?: string;
  type?: string;
  version?: string;
  workspaces?: string[];
}

export interface WorkspacePackage {
  directory: string;
  manifest: PackageManifest;
  name?: string;
}

export type NamedWorkspacePackage = WorkspacePackage & {
  name: string;
};

export interface PackageOwner {
  directory: string;
  manifest: PackageManifest;
  name?: string;
  packageJsonPath: string;
}

export interface ImporterInfo {
  declaredWorkspaceDependencies: Set<string>;
  directory: string;
  name?: string;
}

export type PublishDependencySectionName =
  | 'dependencies'
  | 'peerDependencies'
  | 'optionalDependencies';

export interface DependencySection {
  dependencies: Record<string, string>;
  name: PublishDependencySectionName;
}

export function isNamedWorkspacePackage(
  workspacePackage: WorkspacePackage,
): workspacePackage is NamedWorkspacePackage {
  return Boolean(workspacePackage.name);
}
