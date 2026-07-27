import type { ResolvedLiminaConfig } from '#config/runner';
import type { lstat } from 'node:fs/promises';
import type {
  ExtendedPackageScope,
  PackageScopeRegionBoundary,
  PnpmWorkspaceRegionBoundary,
} from '../../regions';
import type { CompiledExclusionRule } from '../exclusions';
import type { WorkspaceDescriptorCandidate } from '../types';

export interface PackageIslandCollection {
  boundaries: PackageScopeRegionBoundary[];
  descriptors: WorkspaceDescriptorCandidate[];
  extendedScopes: ExtendedPackageScope[];
  pnpmBoundaries: PnpmWorkspaceRegionBoundary[];
}

export interface IslandWalkContext {
  canonicalChildRoots: ReadonlySet<string>;
  childRoots: readonly string[];
  config: ResolvedLiminaConfig;
  ownerRootDir: string;
  result: PackageIslandCollection;
  rules: readonly CompiledExclusionRule[];
}

export type DirectoryEntryStats = Awaited<ReturnType<typeof lstat>>;
export type DirectoryEntries = Map<string, DirectoryEntryStats>;
