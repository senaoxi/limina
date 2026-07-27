import type { ResolvedLiminaConfig } from '#config/runner';
import { normalizeAbsolutePath } from '#utils/path';
import { readWorkspaceManifest } from '@pnpm/workspace.read-manifest';
import { existsSync } from 'node:fs';
import path from 'pathe';
import { glob } from 'tinyglobby';
import { getManifestPackageName, readJsonFile } from './package-manifest';
import type {
  PackageManifest,
  PackageOwner,
  WorkspacePackage,
} from './package-types';
import { isNamedWorkspacePackage } from './package-types';
import { collectWorkspaceRegionTopology } from './regions';

const workspacePackageDiscoveryIgnore = [
  '**/node_modules/**',
  '**/bower_components/**',
  '**/test/**',
  '**/tests/**',
] as const;

function findWorkspaceRoot(currentDir: string, startDir: string): string {
  if (existsSync(path.join(currentDir, 'pnpm-workspace.yaml'))) {
    return currentDir;
  }

  const parentDir = path.dirname(currentDir);

  if (parentDir === currentDir) {
    throw new Error(
      `No pnpm-workspace.yaml was found from ${startDir} or its ancestors.`,
    );
  }

  return findWorkspaceRoot(parentDir, startDir);
}

export function findNearestPnpmWorkspaceRoot(startDir: string): string {
  const normalizedStartDir = normalizeAbsolutePath(startDir);
  return findWorkspaceRoot(normalizedStartDir, normalizedStartDir);
}

function removePatternNegation(pattern: string): string {
  return pattern.startsWith('!') ? pattern.slice(1) : pattern;
}

function createPackageJsonPattern(directoryPattern: string): string {
  if (directoryPattern === '.' || directoryPattern.length === 0) {
    return 'package.json';
  }

  return `${directoryPattern}/package.json`;
}

function toPackageJsonPattern(pattern: string): string {
  const negated = pattern.startsWith('!');
  const directoryPattern = removePatternNegation(pattern).replace(/\/+$/u, '');
  const packageJsonPattern = createPackageJsonPattern(directoryPattern);
  return negated ? `!${packageJsonPattern}` : packageJsonPattern;
}

async function collectRootPackageJsonPaths(
  workspaceRootDir: string,
): Promise<string[]> {
  return glob('package.json', {
    absolute: true,
    cwd: workspaceRootDir,
    expandDirectories: false,
    ignore: [...workspacePackageDiscoveryIgnore],
    onlyFiles: true,
  });
}

async function collectPatternPackageJsonPaths(options: {
  patterns: readonly string[];
  workspaceRootDir: string;
}): Promise<string[]> {
  if (options.patterns.length === 0) {
    return [];
  }

  return glob([...options.patterns], {
    absolute: true,
    cwd: options.workspaceRootDir,
    expandDirectories: false,
    ignore: [...workspacePackageDiscoveryIgnore],
    onlyFiles: true,
  });
}

function normalizePackageJsonPaths(paths: readonly string[]): string[] {
  return [...new Set(paths.map(normalizeAbsolutePath))].sort((left, right) =>
    left.localeCompare(right),
  );
}

function createWorkspacePackage(packageJsonPath: string): WorkspacePackage {
  const manifest = readJsonFile<PackageManifest>(packageJsonPath);
  const name = getManifestPackageName(manifest);
  return {
    directory: normalizeAbsolutePath(path.dirname(packageJsonPath)),
    manifest,
    ...(name === null ? {} : { name }),
  };
}

async function collectPnpmWorkspacePackages(
  config: ResolvedLiminaConfig,
): Promise<WorkspacePackage[]> {
  const workspaceRootDir = findNearestPnpmWorkspaceRoot(config.rootDir);
  const workspaceManifest = await readWorkspaceManifest(workspaceRootDir);
  const patterns = (workspaceManifest?.packages ?? []).map(
    toPackageJsonPattern,
  );
  const [rootPaths, workspacePaths] = await Promise.all([
    collectRootPackageJsonPaths(workspaceRootDir),
    collectPatternPackageJsonPaths({ patterns, workspaceRootDir }),
  ]);
  return normalizePackageJsonPaths([...rootPaths, ...workspacePaths]).map(
    createWorkspacePackage,
  );
}

function compareNamedPriority(
  leftNamed: boolean,
  rightNamed: boolean,
): number | null {
  if (leftNamed === rightNamed) {
    return null;
  }

  return leftNamed ? -1 : 1;
}

function getWorkspacePackageSortKey(
  workspacePackage: WorkspacePackage,
): string {
  return workspacePackage.name ?? workspacePackage.directory;
}

function compareWorkspacePackages(
  left: WorkspacePackage,
  right: WorkspacePackage,
): number {
  const namedPriority = compareNamedPriority(
    isNamedWorkspacePackage(left),
    isNamedWorkspacePackage(right),
  );

  if (namedPriority !== null) {
    return namedPriority;
  }

  const keyOrder = getWorkspacePackageSortKey(left).localeCompare(
    getWorkspacePackageSortKey(right),
  );

  if (keyOrder !== 0) {
    return keyOrder;
  }

  return left.directory.localeCompare(right.directory);
}

function mergeWorkspacePackages(
  packages: readonly WorkspacePackage[],
): WorkspacePackage[] {
  const byDirectory = new Map(
    packages.map((workspacePackage) => [
      workspacePackage.directory,
      workspacePackage,
    ]),
  );
  return [...byDirectory.values()].sort(compareWorkspacePackages);
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
  const topology = await collectWorkspaceRegionTopology(config, {
    provider: collectRawWorkspacePackages,
    rawPackages,
  });
  return topology.packages;
}

function toPackageOwner(workspacePackage: WorkspacePackage): PackageOwner {
  return {
    directory: workspacePackage.directory,
    manifest: workspacePackage.manifest,
    ...(workspacePackage.name === undefined
      ? {}
      : { name: workspacePackage.name }),
    packageJsonPath: normalizeAbsolutePath(
      path.join(workspacePackage.directory, 'package.json'),
    ),
  };
}

export async function collectPackageOwners(
  config: ResolvedLiminaConfig,
): Promise<PackageOwner[]> {
  const packages = await collectWorkspacePackages(config);
  return packages
    .map(toPackageOwner)
    .sort((left, right) => right.directory.length - left.directory.length);
}
