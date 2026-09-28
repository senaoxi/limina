import type { ResolvedLiminaConfig } from '#config/runner';
import type { ImportRecord } from '#core/import-graph/context';
import type { PackageOwner, WorkspacePackage } from '#core/workspace/actions';
import { isPathInsideDirectory, normalizeAbsolutePath } from '#utils/path';
import path from 'pathe';
import { isDependencyAuthorized } from '../core/packages/authority';
import { findMatchingWorkspaceRootDependencyGrant } from './import-authority-grants';
import type {
  CompiledImportAuthorityAllowRule,
  PackageImportAuthorizationResolution,
} from './source-types';

export function getWorkspacePackageJsonPath(
  workspacePackage: WorkspacePackage,
): string {
  return normalizeAbsolutePath(
    path.join(workspacePackage.directory, 'package.json'),
  );
}

function isIntermediatePackage(options: {
  packageDirectory: string;
  ownerDirectory: string;
  rootDirectory: string;
}): boolean {
  const conditions = [
    options.packageDirectory !== options.ownerDirectory,
    options.packageDirectory !== options.rootDirectory,
    isPathInsideDirectory(options.ownerDirectory, options.packageDirectory),
  ];

  return conditions.every(Boolean);
}

function collectIntermediateWorkspacePackages(options: {
  config: ResolvedLiminaConfig;
  owner: PackageOwner;
  packages: WorkspacePackage[];
}): WorkspacePackage[] {
  const ownerDirectory = normalizeAbsolutePath(options.owner.directory);
  const rootDirectory = normalizeAbsolutePath(options.config.rootDir);

  return options.packages
    .filter((workspacePackage) =>
      isIntermediatePackage({
        ownerDirectory,
        packageDirectory: normalizeAbsolutePath(workspacePackage.directory),
        rootDirectory,
      }),
    )
    .sort(
      (left, right) =>
        normalizeAbsolutePath(right.directory).length -
        normalizeAbsolutePath(left.directory).length,
    );
}

export function findWorkspaceRootPackage(options: {
  config: ResolvedLiminaConfig;
  packages: WorkspacePackage[];
}): WorkspacePackage | null {
  const rootDirectory = normalizeAbsolutePath(options.config.rootDir);

  return (
    options.packages.find(
      (workspacePackage) =>
        normalizeAbsolutePath(workspacePackage.directory) === rootDirectory,
    ) ?? null
  );
}

function createOwnerAuthorization(
  owner: PackageOwner,
  packageName: string,
): PackageImportAuthorizationResolution | null {
  if (!isDependencyAuthorized(owner.manifest, packageName)) {
    return null;
  }

  return {
    authorityManifestPaths: [owner.packageJsonPath],
    authorized: true,
  };
}

function shouldUseRootAuthority(options: {
  matchedGrant: CompiledImportAuthorityAllowRule | undefined;
  owner: PackageOwner;
  rootPackage: WorkspacePackage | null;
}): boolean {
  if (!options.matchedGrant || !options.rootPackage) {
    return false;
  }

  return (
    normalizeAbsolutePath(options.rootPackage.directory) !==
    normalizeAbsolutePath(options.owner.directory)
  );
}

function createOwnerOnlyDenial(options: {
  matchedGrant: CompiledImportAuthorityAllowRule | undefined;
  owner: PackageOwner;
}): PackageImportAuthorizationResolution {
  return {
    authorityManifestPaths: [options.owner.packageJsonPath],
    authorized: false,
    ...(options.matchedGrant ? { matchedGrant: options.matchedGrant } : {}),
  };
}

function findIntermediateDependencyPackage(options: {
  intermediatePackages: WorkspacePackage[];
  packageName: string;
}): WorkspacePackage | undefined {
  return options.intermediatePackages.find((workspacePackage) =>
    isDependencyAuthorized(workspacePackage.manifest, options.packageName),
  );
}

function resolveRootAuthorization(options: {
  config: ResolvedLiminaConfig;
  matchedGrant: CompiledImportAuthorityAllowRule;
  owner: PackageOwner;
  packageName: string;
  packages: WorkspacePackage[];
  rootPackage: WorkspacePackage;
}): PackageImportAuthorizationResolution {
  const intermediatePackages = collectIntermediateWorkspacePackages(options);
  const authorityManifestPaths = [
    options.owner.packageJsonPath,
    ...intermediatePackages.map(getWorkspacePackageJsonPath),
    getWorkspacePackageJsonPath(options.rootPackage),
  ];
  const intermediateDependencyPackage = findIntermediateDependencyPackage({
    intermediatePackages,
    packageName: options.packageName,
  });
  if (intermediateDependencyPackage) {
    return {
      authorityManifestPaths,
      authorized: false,
      intermediateDependencyPackage,
      matchedGrant: options.matchedGrant,
    };
  }

  return {
    authorityManifestPaths,
    authorized: isDependencyAuthorized(
      options.rootPackage.manifest,
      options.packageName,
    ),
    matchedGrant: options.matchedGrant,
  };
}

export function resolvePackageImportAuthorization(options: {
  config: ResolvedLiminaConfig;
  importAuthorityAllowRules: CompiledImportAuthorityAllowRule[];
  importRecord: ImportRecord;
  owner: PackageOwner;
  packageName: string;
  packages: WorkspacePackage[];
  rootPackage: WorkspacePackage | null;
}): PackageImportAuthorizationResolution {
  const ownerAuthorization = createOwnerAuthorization(
    options.owner,
    options.packageName,
  );
  if (ownerAuthorization) {
    return ownerAuthorization;
  }

  const matchedGrant = findMatchingWorkspaceRootDependencyGrant(options);
  if (!shouldUseRootAuthority({ ...options, matchedGrant })) {
    return createOwnerOnlyDenial({ matchedGrant, owner: options.owner });
  }

  return resolveRootAuthorization({
    ...options,
    matchedGrant: matchedGrant!,
    rootPackage: options.rootPackage!,
  });
}
