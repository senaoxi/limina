import type { ResolvedLiminaConfig } from '#config/runner';
import { normalizeAbsolutePath } from '#utils/path';
import { existsSync } from 'node:fs';
import path from 'pathe';
import { expandPackageGlobs } from './expand-package-globs';
import { getManifestPackageName, readJsonFile } from './package-manifest';
import type {
  PackageManifest,
  PackageOwner,
  WorkspacePackage,
} from './package-types';
import { isNamedWorkspacePackage } from './package-types';
import { collectWorkspaceRegionTopology } from './regions';
import { workspacePackageManagerAdapters } from './selection-policy';

function createWorkspacePackage(
  packageJsonPath: string,
  manifest = readJsonFile<PackageManifest>(packageJsonPath),
): WorkspacePackage {
  const name = getManifestPackageName(manifest);
  return {
    directory: normalizeAbsolutePath(path.dirname(packageJsonPath)),
    manifest,
    ...(name === null ? {} : { name }),
  };
}

async function collectDeclaredWorkspacePackages(
  config: ResolvedLiminaConfig,
): Promise<WorkspacePackage[]> {
  const workspace = config.governanceRoot;
  const rootPackage = createWorkspacePackage(
    workspace.manifestPath,
    workspace.manifest,
  );
  if (workspace.kind === 'single-package') return [rootPackage];
  const policy =
    await workspacePackageManagerAdapters[
      workspace.packageManager
    ].readSelectionPolicy(workspace);
  const directories = await expandPackageGlobs({
    ...policy,
    rootDir: workspace.rootDir,
  });
  return [
    rootPackage,
    ...[...new Set(directories)]
      .filter((directory) => directory !== workspace.rootDir)
      .map((directory) => path.join(directory, 'package.json'))
      .filter((manifestPath) => existsSync(manifestPath))
      .map((manifestPath) => createWorkspacePackage(manifestPath)),
  ];
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
  return mergeWorkspacePackages(await collectDeclaredWorkspacePackages(config));
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
