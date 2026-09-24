import type { ResolvedLiminaConfig } from '#config/runner';
import { existsSync } from 'node:fs';
import path from 'pathe';
import { getDependencySections } from './package-dependencies';
import { readJsonFile } from './package-manifest';
import type {
  ImporterInfo,
  PackageManifest,
  WorkspacePackage,
} from './package-types';
import { isNamedWorkspacePackage } from './package-types';

function collectWorkspacePackageNames(
  packages: readonly WorkspacePackage[],
): Set<string> {
  return new Set(
    packages
      .filter(isNamedWorkspacePackage)
      .map((workspacePackage) => workspacePackage.name),
  );
}

function addDeclaredDependencies(options: {
  declared: Set<string>;
  dependencies: Readonly<Record<string, string>>;
  workspacePackageNames: ReadonlySet<string>;
}): void {
  for (const dependencyName of Object.keys(options.dependencies)) {
    if (options.workspacePackageNames.has(dependencyName)) {
      options.declared.add(dependencyName);
    }
  }
}

function collectDeclaredWorkspaceDependencies(options: {
  manifest: PackageManifest;
  workspacePackageNames: ReadonlySet<string>;
}): Set<string> {
  const declared = new Set<string>();

  for (const dependencies of getDependencySections(options.manifest)) {
    addDeclaredDependencies({
      declared,
      dependencies,
      workspacePackageNames: options.workspacePackageNames,
    });
  }

  return declared;
}

function createImporter(options: {
  directory: string;
  manifest?: PackageManifest;
  workspacePackageNames: ReadonlySet<string>;
}): ImporterInfo | null {
  const packageJsonPath = path.join(options.directory, 'package.json');

  const manifest = options.manifest ?? readImporterManifest(packageJsonPath);
  if (manifest === null) return null;
  return {
    declaredWorkspaceDependencies: collectDeclaredWorkspaceDependencies({
      manifest,
      workspacePackageNames: options.workspacePackageNames,
    }),
    directory: options.directory,
    name: manifest.name,
  };
}

function readImporterManifest(packageJsonPath: string): PackageManifest | null {
  return existsSync(packageJsonPath)
    ? readJsonFile<PackageManifest>(packageJsonPath)
    : null;
}
function getRootManifest(
  config: ResolvedLiminaConfig,
  directory: string,
): PackageManifest | undefined {
  return directory === config.governanceRoot.rootDir
    ? config.governanceRoot.manifest
    : undefined;
}

function collectImporterDirectories(options: {
  config: ResolvedLiminaConfig;
  packages: readonly WorkspacePackage[];
}): Set<string> {
  return new Set([
    options.config.rootDir,
    ...options.packages.map((workspacePackage) => workspacePackage.directory),
  ]);
}

export function collectImporters(
  config: ResolvedLiminaConfig,
  packages: WorkspacePackage[],
): ImporterInfo[] {
  const workspacePackageNames = collectWorkspacePackageNames(packages);
  const importers: ImporterInfo[] = [];

  for (const directory of collectImporterDirectories({ config, packages })) {
    const importer = createImporter({
      directory,
      workspacePackageNames,
      manifest: getRootManifest(config, directory),
    });

    if (importer !== null) {
      importers.push(importer);
    }
  }

  return importers.sort(
    (left, right) => right.directory.length - left.directory.length,
  );
}
