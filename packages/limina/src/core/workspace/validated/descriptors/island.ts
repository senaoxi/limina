import type { ResolvedLiminaConfig } from '#config/runner';
import { normalizeAbsolutePath } from '#utils/path';
import type { WorkspacePackage } from '../../actions';
import type { CompiledExclusionRule } from '../exclusions';
import { isInsideOrEqual } from '../shared';
import type { WorkspacePackageIdentity } from '../types';
import type { IslandWalkContext, PackageIslandCollection } from './types';
import { walkPackageIsland } from './walk';

function findOwnerIdentity(options: {
  identities: readonly WorkspacePackageIdentity[];
  owner: WorkspacePackage;
  ownerRootDir: string;
}): WorkspacePackageIdentity {
  const identity = options.identities.find(
    (candidate) => candidate.package === options.owner,
  );
  if (identity !== undefined) return identity;
  throw new Error(`Missing workspace identity for ${options.ownerRootDir}.`);
}

function collectChildRoots(options: {
  activatedPackages: readonly WorkspacePackage[];
  ownerRootDir: string;
}): string[] {
  return options.activatedPackages
    .map((workspacePackage) =>
      normalizeAbsolutePath(workspacePackage.directory),
    )
    .filter((candidate) => candidate !== options.ownerRootDir)
    .filter((candidate) => isInsideOrEqual(options.ownerRootDir, candidate));
}

function collectCanonicalChildRoots(options: {
  activatedIdentities: readonly WorkspacePackageIdentity[];
  ownerIdentity: WorkspacePackageIdentity;
}): Set<string> {
  return new Set(
    options.activatedIdentities
      .map((identity) => identity.canonicalDirectory)
      .filter(
        (candidate) => candidate !== options.ownerIdentity.canonicalDirectory,
      )
      .filter((candidate) =>
        isInsideOrEqual(options.ownerIdentity.canonicalDirectory, candidate),
      ),
  );
}

function createIslandResult(): PackageIslandCollection {
  return {
    boundaries: [],
    descriptors: [],
    extendedScopes: [],
    pnpmBoundaries: [],
  };
}

function createWalkContext(options: {
  activatedIdentities: readonly WorkspacePackageIdentity[];
  activatedPackages: readonly WorkspacePackage[];
  config: ResolvedLiminaConfig;
  owner: WorkspacePackage;
  ownerIdentity: WorkspacePackageIdentity;
  ownerRootDir: string;
  rules: readonly CompiledExclusionRule[];
}): IslandWalkContext {
  return {
    canonicalChildRoots: collectCanonicalChildRoots({
      activatedIdentities: options.activatedIdentities,
      ownerIdentity: options.ownerIdentity,
    }),
    childRoots: collectChildRoots({
      activatedPackages: options.activatedPackages,
      ownerRootDir: options.ownerRootDir,
    }),
    config: options.config,
    ownerRootDir: options.ownerRootDir,
    result: createIslandResult(),
    rules: options.rules,
  };
}

export async function collectPackageIsland(options: {
  activatedIdentities: readonly WorkspacePackageIdentity[];
  activatedPackages: readonly WorkspacePackage[];
  config: ResolvedLiminaConfig;
  owner: WorkspacePackage;
  rules: readonly CompiledExclusionRule[];
}): Promise<PackageIslandCollection> {
  const ownerRootDir = normalizeAbsolutePath(options.owner.directory);
  const ownerIdentity = findOwnerIdentity({
    identities: options.activatedIdentities,
    owner: options.owner,
    ownerRootDir,
  });
  const context = createWalkContext({
    ...options,
    ownerIdentity,
    ownerRootDir,
  });
  await walkPackageIsland(context, ownerRootDir, true);
  return context.result;
}

export type { PackageIslandCollection } from './types';
