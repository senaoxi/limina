import type { WorkspacePackage } from '#core/workspace/actions';
import { isNamedWorkspacePackage } from '#core/workspace/actions';
import { toRelativePath } from '#utils/path';
import type {
  KnipConfig,
  KnipOwnerProject,
  KnipWorkspaceConfig,
} from './types';

function getIgnoredDependencyName(options: {
  dependencyKey: string;
  packageName: string;
}): string | null {
  const [importerName, dependencyName] = options.dependencyKey.split('\0');
  if (importerName !== options.packageName) {
    return null;
  }

  return dependencyName === undefined ? null : dependencyName;
}

function getIgnoredDependenciesForPackage(options: {
  ignoredKeys: ReadonlySet<string>;
  packageName: string;
}): string[] {
  const dependencies: string[] = [];

  for (const dependencyKey of options.ignoredKeys) {
    const dependencyName = getIgnoredDependencyName({
      dependencyKey,
      packageName: options.packageName,
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
  workspacePackage: WorkspacePackage;
  workspaces: Record<string, KnipWorkspaceConfig>;
}): void {
  if (!isNamedWorkspacePackage(options.workspacePackage)) {
    return;
  }

  const dependencies = getIgnoredDependenciesForPackage({
    ignoredKeys: options.ignoredKeys,
    packageName: options.workspacePackage.name,
  });
  if (dependencies.length === 0) {
    return;
  }

  options.workspaces[
    toRelativePath(options.rootDir, options.workspacePackage.directory)
  ] = {
    ignoreDependencies: dependencies,
  };
}

function createIgnoredDependenciesByWorkspace(options: {
  ignoredKeys: ReadonlySet<string>;
  rootDir: string;
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
  if (options.directory === options.rootDir) {
    return options.knipConfig;
  }

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
  workspacePackages: readonly WorkspacePackage[];
}): KnipConfig {
  const knipConfig: KnipConfig = {
    $schema: 'https://unpkg.com/knip@6/schema.json',
  };
  const workspaces = createIgnoredDependenciesByWorkspace({
    ignoredKeys: options.ignoredKeys,
    rootDir: options.rootDir,
    workspacePackages: options.workspacePackages,
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
