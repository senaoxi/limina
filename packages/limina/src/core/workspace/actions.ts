import type { ResolvedLiminaConfig } from '#config/runner';
import { normalizeAbsolutePath } from '#utils/path';
import { readWorkspaceManifest } from '@pnpm/workspace.read-manifest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'pathe';
import { glob } from 'tinyglobby';
import { collectWorkspaceRegionTopology } from './regions';

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

export function readJsonFile<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '')) as T;
}

function getManifestPackageName(manifest: PackageManifest): string | null {
  return typeof manifest.name === 'string' && manifest.name.trim().length > 0
    ? manifest.name.trim()
    : null;
}

export function isNamedWorkspacePackage(
  workspacePackage: WorkspacePackage,
): workspacePackage is NamedWorkspacePackage {
  return Boolean(workspacePackage.name);
}

const workspacePackageDiscoveryIgnore = [
  '**/node_modules/**',
  '**/bower_components/**',
  '**/test/**',
  '**/tests/**',
] as const;

function toPackageJsonPattern(pattern: string): string {
  const negated = pattern.startsWith('!');
  const directoryPattern = (negated ? pattern.slice(1) : pattern).replace(
    /\/+$/u,
    '',
  );
  const packageJsonPattern =
    directoryPattern === '.' || directoryPattern.length === 0
      ? 'package.json'
      : `${directoryPattern}/package.json`;

  return negated ? `!${packageJsonPattern}` : packageJsonPattern;
}

async function collectPnpmWorkspacePackages(
  config: ResolvedLiminaConfig,
): Promise<WorkspacePackage[]> {
  const workspaceManifest = await readWorkspaceManifest(config.rootDir);
  const packageJsonPatterns = (workspaceManifest?.packages ?? []).map(
    toPackageJsonPattern,
  );
  const [rootPackageJsonPaths, workspacePackageJsonPaths] = await Promise.all([
    glob('package.json', {
      absolute: true,
      cwd: config.rootDir,
      expandDirectories: false,
      ignore: [...workspacePackageDiscoveryIgnore],
      onlyFiles: true,
    }),
    packageJsonPatterns.length > 0
      ? glob(packageJsonPatterns, {
          absolute: true,
          cwd: config.rootDir,
          expandDirectories: false,
          ignore: [...workspacePackageDiscoveryIgnore],
          onlyFiles: true,
        })
      : [],
  ]);
  const packageJsonPaths = [
    ...new Set(
      [...rootPackageJsonPaths, ...workspacePackageJsonPaths].map(
        normalizeAbsolutePath,
      ),
    ),
  ].sort((left, right) => left.localeCompare(right));

  return packageJsonPaths.map((packageJsonPath) => {
    const manifest = readJsonFile<PackageManifest>(packageJsonPath);
    const name = getManifestPackageName(manifest);

    return {
      directory: normalizeAbsolutePath(path.dirname(packageJsonPath)),
      manifest,
      ...(name ? { name } : {}),
    };
  });
}

function mergeWorkspacePackages(
  packages: WorkspacePackage[],
): WorkspacePackage[] {
  const byDirectory = new Map<string, WorkspacePackage>();

  for (const workspacePackage of packages) {
    byDirectory.set(workspacePackage.directory, workspacePackage);
  }

  return [...byDirectory.values()].sort((left, right) => {
    const leftHasName = isNamedWorkspacePackage(left);
    const rightHasName = isNamedWorkspacePackage(right);

    if (leftHasName !== rightHasName) {
      return leftHasName ? -1 : 1;
    }

    const leftKey = left.name ?? left.directory;
    const rightKey = right.name ?? right.directory;
    const keyOrder = leftKey.localeCompare(rightKey);

    return keyOrder === 0
      ? left.directory.localeCompare(right.directory)
      : keyOrder;
  });
}

export async function collectRawWorkspacePackages(
  config: ResolvedLiminaConfig,
): Promise<WorkspacePackage[]> {
  return mergeWorkspacePackages(await collectPnpmWorkspacePackages(config));
}

export async function collectWorkspacePackages(
  config: ResolvedLiminaConfig,
): Promise<WorkspacePackage[]> {
  const rawPackages = await collectRawWorkspacePackages(config);

  return (
    await collectWorkspaceRegionTopology(config, {
      provider: collectRawWorkspacePackages,
      rawPackages,
    })
  ).packages;
}

export async function collectPackageOwners(
  config: ResolvedLiminaConfig,
): Promise<PackageOwner[]> {
  return (await collectWorkspacePackages(config))
    .map((workspacePackage) => ({
      directory: workspacePackage.directory,
      manifest: workspacePackage.manifest,
      ...(workspacePackage.name ? { name: workspacePackage.name } : {}),
      packageJsonPath: normalizeAbsolutePath(
        path.join(workspacePackage.directory, 'package.json'),
      ),
    }))
    .sort((left, right) => right.directory.length - left.directory.length);
}

function getDependencySections(
  importer: PackageManifest,
): Record<string, string>[] {
  return [
    importer.dependencies,
    importer.devDependencies,
    importer.optionalDependencies,
    importer.peerDependencies,
  ].filter((section): section is Record<string, string> => Boolean(section));
}

export function getPublishDependencySections(
  importer: PackageManifest,
): DependencySection[] {
  return [
    {
      dependencies: importer.dependencies,
      name: 'dependencies',
    },
    {
      dependencies: importer.peerDependencies,
      name: 'peerDependencies',
    },
    {
      dependencies: importer.optionalDependencies,
      name: 'optionalDependencies',
    },
  ].filter((section): section is DependencySection =>
    Boolean(section.dependencies),
  );
}

export function isWorkspaceDependencySpecifier(specifier: string): boolean {
  return specifier.startsWith('workspace:');
}

export function isLocalPackageDependencySpecifier(specifier: string): boolean {
  return (
    specifier.startsWith('workspace:') ||
    specifier.startsWith('link:') ||
    specifier.startsWith('file:') ||
    specifier.startsWith('catalog:')
  );
}

export function getPackageRootSpecifier(specifier: string): string {
  if (specifier.startsWith('@')) {
    const [scope, name] = specifier.split('/');

    return scope && name ? `${scope}/${name}` : specifier;
  }

  return specifier.split('/')[0] ?? specifier;
}

export function findPackageForSpecifier(
  specifier: string,
  packages: WorkspacePackage[],
): NamedWorkspacePackage | null {
  const packageName = getPackageRootSpecifier(specifier);

  return (
    packages
      .filter(isNamedWorkspacePackage)
      .find((workspacePackage) => workspacePackage.name === packageName) ?? null
  );
}

export function collectImporters(
  config: ResolvedLiminaConfig,
  packages: WorkspacePackage[],
): ImporterInfo[] {
  const workspacePackageNames = new Set(
    packages
      .filter(isNamedWorkspacePackage)
      .map((workspacePackage) => workspacePackage.name),
  );
  const importerDirectories = new Set<string>([
    config.rootDir,
    ...packages.map((workspacePackage) => workspacePackage.directory),
  ]);
  const importers: ImporterInfo[] = [];

  for (const importerDirectory of importerDirectories) {
    const packageJsonPath = path.join(importerDirectory, 'package.json');

    if (!existsSync(packageJsonPath)) {
      continue;
    }

    const manifest = readJsonFile<PackageManifest>(packageJsonPath);
    const declaredWorkspaceDependencies = new Set<string>();

    for (const dependencies of getDependencySections(manifest)) {
      for (const dependencyName of Object.keys(dependencies)) {
        if (!workspacePackageNames.has(dependencyName)) {
          continue;
        }

        declaredWorkspaceDependencies.add(dependencyName);
      }
    }

    importers.push({
      declaredWorkspaceDependencies,
      directory: importerDirectory,
      name: manifest.name,
    });
  }

  return importers.sort(
    (left, right) => right.directory.length - left.directory.length,
  );
}
