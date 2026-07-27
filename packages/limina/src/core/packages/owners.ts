import {
  type PackageManifest,
  type PackageOwner,
  readJsonFile,
  type WorkspacePackage,
} from '#core/workspace/actions';
import { isPathInsideDirectory, normalizeAbsolutePath } from '#utils/path';
import { existsSync } from 'node:fs';
import path from 'pathe';

export interface NearestPackageInfo {
  directory: string;
  manifest: PackageManifest;
  name?: string;
  packageJsonPath: string;
}

export type ResolvedPackageTarget =
  | {
      kind: 'current-owner';
      packageInfo: NearestPackageInfo;
    }
  | {
      kind: 'other-owner';
      packageInfo: NearestPackageInfo;
      targetOwner: PackageOwner;
      workspacePackage: WorkspacePackage | null;
    }
  | {
      kind: 'artifact-package';
      packageInfo: NearestPackageInfo;
    }
  | {
      kind: 'unowned';
    };

export function findOwnerForFile(
  filePath: string,
  owners: PackageOwner[],
): PackageOwner | null {
  return (
    owners
      .filter((owner) => isPathInsideDirectory(filePath, owner.directory))
      .sort(
        (left, right) => right.directory.length - left.directory.length,
      )[0] ?? null
  );
}

function getManifestPackageName(manifest: PackageManifest): string | undefined {
  return typeof manifest.name === 'string' && manifest.name.trim().length > 0
    ? manifest.name.trim()
    : undefined;
}

function isNodeModulesPackageRoot(directory: string): boolean {
  const parentDirectory = path.dirname(directory);
  const parentName = path.basename(parentDirectory);

  if (parentName === 'node_modules') {
    return true;
  }

  return parentName.startsWith('@')
    ? path.basename(path.dirname(parentDirectory)) === 'node_modules'
    : false;
}

function isPackageInfoInsideNodeModules(
  packageInfo: NearestPackageInfo,
): boolean {
  return normalizeAbsolutePath(packageInfo.directory)
    .split('/')
    .includes('node_modules');
}

function readPackageInfo(packageJsonPath: string): NearestPackageInfo {
  const normalizedPackageJsonPath = normalizeAbsolutePath(packageJsonPath);
  const directory = normalizeAbsolutePath(path.dirname(packageJsonPath));
  const manifest = readJsonFile<PackageManifest>(normalizedPackageJsonPath);
  const name = getManifestPackageName(manifest);

  return {
    directory,
    manifest,
    name,
    packageJsonPath: normalizedPackageJsonPath,
  };
}

function readPackageInfoIfPresent(
  directory: string,
): NearestPackageInfo | null {
  const packageJsonPath = normalizeAbsolutePath(
    path.join(directory, 'package.json'),
  );

  return existsSync(packageJsonPath) ? readPackageInfo(packageJsonPath) : null;
}

function isAcceptedPackageInfo(
  packageInfo: NearestPackageInfo | null,
  accept: (packageInfo: NearestPackageInfo) => boolean,
): packageInfo is NearestPackageInfo {
  return packageInfo !== null && accept(packageInfo);
}

function findNearestAcceptedPackageInfo(
  currentDir: string,
  accept: (packageInfo: NearestPackageInfo) => boolean,
): NearestPackageInfo | null {
  const packageInfo = readPackageInfoIfPresent(currentDir);

  if (isAcceptedPackageInfo(packageInfo, accept)) {
    return packageInfo;
  }

  const parentDir = path.dirname(currentDir);

  if (parentDir === currentDir) {
    return null;
  }

  return findNearestAcceptedPackageInfo(parentDir, accept);
}

function getPackageSearchStartDirectory(filePath: string): string {
  return normalizeAbsolutePath(path.dirname(normalizeAbsolutePath(filePath)));
}

export function findNearestPackageScopeInfo(
  filePath: string,
): NearestPackageInfo | null {
  return findNearestAcceptedPackageInfo(
    getPackageSearchStartDirectory(filePath),
    () => true,
  );
}

function isNamedOrNodeModulesPackage(packageInfo: NearestPackageInfo): boolean {
  return (
    packageInfo.name !== undefined ||
    isNodeModulesPackageRoot(packageInfo.directory)
  );
}

function findNearestPackageInfo(filePath: string): NearestPackageInfo | null {
  return findNearestAcceptedPackageInfo(
    getPackageSearchStartDirectory(filePath),
    isNamedOrNodeModulesPackage,
  );
}

function matchesWorkspacePackage(
  packageInfo: NearestPackageInfo,
  workspacePackage: WorkspacePackage,
): boolean {
  const packageJsonPath = normalizeAbsolutePath(
    path.join(workspacePackage.directory, 'package.json'),
  );
  const matchesPath = packageJsonPath === packageInfo.packageJsonPath;
  const matchesName =
    packageInfo.name !== undefined &&
    workspacePackage.name === packageInfo.name;

  return matchesPath || matchesName;
}

function findWorkspacePackageForPackageInfo(
  packageInfo: NearestPackageInfo,
  packages: WorkspacePackage[],
): WorkspacePackage | null {
  return (
    packages.find((workspacePackage) =>
      matchesWorkspacePackage(packageInfo, workspacePackage),
    ) ?? null
  );
}

function createOwnerPackageInfo(owner: PackageOwner): NearestPackageInfo {
  return {
    directory: owner.directory,
    manifest: owner.manifest,
    ...(owner.name ? { name: owner.name } : {}),
    packageJsonPath: owner.packageJsonPath,
  };
}

function isSameOwner(
  owner: PackageOwner,
  targetOwner: PackageOwner | null,
): boolean {
  return targetOwner?.packageJsonPath === owner.packageJsonPath;
}

function classifyMissingPackageInfo(
  owner: PackageOwner,
  targetOwner: PackageOwner | null,
): ResolvedPackageTarget {
  return isSameOwner(owner, targetOwner)
    ? { kind: 'current-owner', packageInfo: createOwnerPackageInfo(owner) }
    : { kind: 'unowned' };
}

function isCurrentOwnerPackage(options: {
  owner: PackageOwner;
  packageInfo: NearestPackageInfo;
  targetOwner: PackageOwner | null;
}): boolean {
  return (
    isSameOwner(options.owner, options.targetOwner) &&
    !isPackageInfoInsideNodeModules(options.packageInfo)
  );
}

function isOtherOwner(
  owner: PackageOwner,
  targetOwner: PackageOwner | null,
): targetOwner is PackageOwner {
  return (
    targetOwner !== null &&
    targetOwner.packageJsonPath !== owner.packageJsonPath
  );
}

function classifyKnownPackageInfo(options: {
  owner: PackageOwner;
  packageInfo: NearestPackageInfo;
  packages: WorkspacePackage[];
  targetOwner: PackageOwner | null;
}): ResolvedPackageTarget {
  if (isCurrentOwnerPackage(options)) {
    return { kind: 'current-owner', packageInfo: options.packageInfo };
  }

  if (isOtherOwner(options.owner, options.targetOwner)) {
    return {
      kind: 'other-owner',
      packageInfo: options.packageInfo,
      targetOwner: options.targetOwner,
      workspacePackage: findWorkspacePackageForPackageInfo(
        options.packageInfo,
        options.packages,
      ),
    };
  }

  return { kind: 'artifact-package', packageInfo: options.packageInfo };
}

export function classifyResolvedPackageTarget(options: {
  owner: PackageOwner;
  owners: PackageOwner[];
  packages: WorkspacePackage[];
  resolvedFilePath: string;
}): ResolvedPackageTarget {
  const packageInfo = findNearestPackageInfo(options.resolvedFilePath);
  const targetOwner = findOwnerForFile(
    options.resolvedFilePath,
    options.owners,
  );

  if (!packageInfo) {
    return classifyMissingPackageInfo(options.owner, targetOwner);
  }

  return classifyKnownPackageInfo({
    owner: options.owner,
    packageInfo,
    packages: options.packages,
    targetOwner,
  });
}
