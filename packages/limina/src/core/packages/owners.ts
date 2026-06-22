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

  if (parentName.startsWith('@')) {
    return path.basename(path.dirname(parentDirectory)) === 'node_modules';
  }

  return false;
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

export function findNearestPackageScopeInfo(
  filePath: string,
): NearestPackageInfo | null {
  const normalizedFilePath = normalizeAbsolutePath(filePath);
  let currentDir = normalizeAbsolutePath(path.dirname(normalizedFilePath));

  while (true) {
    const packageJsonPath = normalizeAbsolutePath(
      path.join(currentDir, 'package.json'),
    );

    if (existsSync(packageJsonPath)) {
      return readPackageInfo(packageJsonPath);
    }

    const parentDir = path.dirname(currentDir);

    if (parentDir === currentDir) {
      return null;
    }

    currentDir = parentDir;
  }
}

function findNearestPackageInfo(filePath: string): NearestPackageInfo | null {
  const normalizedFilePath = normalizeAbsolutePath(filePath);
  let currentDir = normalizeAbsolutePath(path.dirname(normalizedFilePath));

  while (true) {
    const packageJsonPath = normalizeAbsolutePath(
      path.join(currentDir, 'package.json'),
    );

    if (existsSync(packageJsonPath)) {
      const packageInfo = readPackageInfo(packageJsonPath);

      if (packageInfo.name || isNodeModulesPackageRoot(currentDir)) {
        return packageInfo;
      }
    }

    const parentDir = path.dirname(currentDir);

    if (parentDir === currentDir) {
      return null;
    }

    currentDir = parentDir;
  }
}

function findWorkspacePackageForPackageInfo(
  packageInfo: NearestPackageInfo,
  packages: WorkspacePackage[],
): WorkspacePackage | null {
  return (
    packages.find((workspacePackage) => {
      const packageJsonPath = normalizeAbsolutePath(
        path.join(workspacePackage.directory, 'package.json'),
      );

      return (
        packageJsonPath === packageInfo.packageJsonPath ||
        (packageInfo.name !== undefined &&
          workspacePackage.name === packageInfo.name)
      );
    }) ?? null
  );
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
    if (targetOwner?.packageJsonPath === options.owner.packageJsonPath) {
      return {
        kind: 'current-owner',
        packageInfo: {
          directory: options.owner.directory,
          manifest: options.owner.manifest,
          ...(options.owner.name ? { name: options.owner.name } : {}),
          packageJsonPath: options.owner.packageJsonPath,
        },
      };
    }

    return {
      kind: 'unowned',
    };
  }

  if (
    targetOwner?.packageJsonPath === options.owner.packageJsonPath &&
    !isPackageInfoInsideNodeModules(packageInfo)
  ) {
    return {
      kind: 'current-owner',
      packageInfo,
    };
  }

  if (
    targetOwner &&
    targetOwner.packageJsonPath !== options.owner.packageJsonPath
  ) {
    return {
      kind: 'other-owner',
      packageInfo,
      targetOwner,
      workspacePackage: findWorkspacePackageForPackageInfo(
        packageInfo,
        options.packages,
      ),
    };
  }

  return {
    kind: 'artifact-package',
    packageInfo,
  };
}
