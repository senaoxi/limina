import type { WorkspacePackage } from '#core/workspace/actions';
import { toRelativePath } from '#utils/path';
import {
  getPackageOwnerIdentity,
  type PackageOwnerIdentity,
} from '../../core/workspace/owner-identity';
import type { ValidatedWorkspaceContext } from '../../core/workspace/validated-context';
import type {
  KnipConfig,
  KnipOwnerProject,
  KnipWorkspaceConfig,
} from './types';

function getIgnoredDependencyName(options: {
  dependencyKey: string;
  ownerIdentity: PackageOwnerIdentity;
}): string | null {
  const [importerName, dependencyName] = options.dependencyKey.split('\0');
  if (importerName !== options.ownerIdentity) {
    return null;
  }

  return dependencyName === undefined ? null : dependencyName;
}

function getIgnoredDependenciesForPackage(options: {
  ignoredKeys: ReadonlySet<string>;
  ownerIdentity: PackageOwnerIdentity;
}): string[] {
  const dependencies: string[] = [];

  for (const dependencyKey of options.ignoredKeys) {
    const dependencyName = getIgnoredDependencyName({
      dependencyKey,
      ownerIdentity: options.ownerIdentity,
    });
    if (dependencyName !== null) {
      dependencies.push(dependencyName);
    }
  }

  return dependencies.sort();
}

function addIgnoredWorkspaceConfig(options: {
  ignoredKeys: ReadonlySet<string>;
  rootDir: string;
  workspaceContext: ValidatedWorkspaceContext;
  workspacePackage: WorkspacePackage;
  workspaces: Record<string, KnipWorkspaceConfig>;
}): void {
  const dependencies = getIgnoredDependenciesForPackage({
    ignoredKeys: options.ignoredKeys,
    ownerIdentity: getPackageOwnerIdentity(
      options.workspaceContext,
      options.workspacePackage.directory,
    ),
  });
  options.workspaces[
    toRelativePath(options.rootDir, options.workspacePackage.directory)
  ] = {
    ignoreDependencies: dependencies,
  };
}

function createIgnoredDependenciesByWorkspace(options: {
  ignoredKeys: ReadonlySet<string>;
  rootDir: string;
  workspaceContext: ValidatedWorkspaceContext;
  workspacePackages: readonly WorkspacePackage[];
}): Record<string, KnipWorkspaceConfig> {
  const workspaces: Record<string, KnipWorkspaceConfig> = {};

  for (const workspacePackage of options.workspacePackages) {
    addIgnoredWorkspaceConfig({ ...options, workspacePackage, workspaces });
  }

  return workspaces;
}

function ensureWorkspaceMap(
  config: KnipConfig,
): Record<string, KnipWorkspaceConfig> {
  if (config.workspaces === undefined) {
    config.workspaces = {};
  }

  return config.workspaces;
}

function ensureWorkspaceConfig(
  workspaces: Record<string, KnipWorkspaceConfig>,
  workspaceKey: string,
): KnipWorkspaceConfig {
  const existing = workspaces[workspaceKey];
  if (existing !== undefined) {
    return existing;
  }

  const created: KnipWorkspaceConfig = {};
  workspaces[workspaceKey] = created;
  return created;
}

function getKnipWorkspaceConfig(options: {
  directory: string;
  knipConfig: KnipConfig;
  rootDir: string;
}): KnipWorkspaceConfig {
  return ensureWorkspaceConfig(
    ensureWorkspaceMap(options.knipConfig),
    toRelativePath(options.rootDir, options.directory),
  );
}

function applyOwnerProjectConfig(
  workspaceConfig: KnipWorkspaceConfig,
  ownerProject: KnipOwnerProject,
): void {
  workspaceConfig.entry = ownerProject.entryFiles;
  if (ownerProject.projectFiles.length > 0) {
    workspaceConfig.project = ownerProject.projectFiles;
  }
  if (ownerProject.ignoreFiles.length > 0) {
    workspaceConfig.ignoreFiles = ownerProject.ignoreFiles;
  }
}

function addOwnerProjectsToKnipConfig(options: {
  knipConfig: KnipConfig;
  ownerProjects: readonly KnipOwnerProject[];
  rootDir: string;
}): void {
  for (const ownerProject of options.ownerProjects) {
    const workspaceConfig = getKnipWorkspaceConfig({
      directory: ownerProject.directory,
      knipConfig: options.knipConfig,
      rootDir: options.rootDir,
    });
    applyOwnerProjectConfig(workspaceConfig, ownerProject);
  }
}

export function createVirtualEntryContent(
  sourceFiles: readonly string[],
  entryDir: string,
): string {
  const imports = sourceFiles
    .map((sourceFile) => {
      const relativePath = toRelativePath(entryDir, sourceFile);
      const specifier = relativePath.startsWith('.')
        ? relativePath
        : `./${relativePath}`;
      return `import ${JSON.stringify(specifier)};`;
    })
    .sort();

  return [
    '// Generated temporarily by Limina for Knip source analysis.',
    ...imports,
    '',
  ].join('\n');
}

export function createKnipConfigForSourceAnalysis(options: {
  ignoredKeys: ReadonlySet<string>;
  ownerProjects: readonly KnipOwnerProject[];
  rootDir: string;
  workspaceContext: ValidatedWorkspaceContext;
  workspacePackages: readonly WorkspacePackage[];
}): KnipConfig {
  const knipConfig: KnipConfig = {
    $schema: 'https://unpkg.com/knip@6/schema.json',
  };
  const workspaces = createIgnoredDependenciesByWorkspace({
    ignoredKeys: options.ignoredKeys,
    rootDir: options.rootDir,
    workspacePackages: options.workspacePackages,
    workspaceContext: options.workspaceContext,
  });
  if (Object.keys(workspaces).length > 0) {
    knipConfig.workspaces = workspaces;
  }

  addOwnerProjectsToKnipConfig({
    knipConfig,
    ownerProjects: options.ownerProjects,
    rootDir: options.rootDir,
  });
  return knipConfig;
}
