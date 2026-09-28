import type { ResolvedLiminaConfig } from '#config/runner';
import type { WorkspaceRootDescriptor } from '#utils/workspace-root';
import type { WorkspacePackage } from './package-types';
import { collectValidatedWorkspaceContext } from './validated-context';

interface WorkspaceRegionBoundaryBase {
  rootDir: string;
}

interface ExcludableWorkspaceRegionBoundaryBase
  extends WorkspaceRegionBoundaryBase {
  excluded: boolean;
  exclusionReason?: string;
}

export interface PackageScopeRegionBoundary
  extends ExcludableWorkspaceRegionBoundaryBase {
  allowWorkspacePackageReentry?: boolean;
  kind: 'package-scope';
  packageJsonPath: string;
}

export interface WorkspaceRootInspection {
  reason: string;
  status: 'excluded';
}

export interface WorkspaceRootRegionBoundary
  extends WorkspaceRegionBoundaryBase {
  inspection: WorkspaceRootInspection;
  kind: 'workspace-root';
  descriptor: WorkspaceRootDescriptor;
}

export type WorkspaceRegionBoundary =
  | PackageScopeRegionBoundary
  | WorkspaceRootRegionBoundary;

function getPackageScopeExclusionReason(
  boundary: PackageScopeRegionBoundary,
): string | null {
  if (!boundary.excluded) {
    return null;
  }

  return boundary.exclusionReason ?? null;
}

export function getWorkspaceRegionBoundaryExclusionReason(
  boundary: WorkspaceRegionBoundary,
): string | null {
  return boundary.kind === 'workspace-root'
    ? boundary.inspection.reason
    : getPackageScopeExclusionReason(boundary);
}

export function isWorkspaceRegionBoundaryExcluded(
  boundary: WorkspaceRegionBoundary,
): boolean {
  return boundary.kind === 'workspace-root' || boundary.excluded;
}

export interface ExtendedPackageScope {
  ownerDirectory: string;
  packageJsonPath: string;
  rootDir: string;
}

export interface WorkspaceRegionTopology {
  boundaries: WorkspaceRegionBoundary[];
  extendedPackageScopes: ExtendedPackageScope[];
  packages: WorkspacePackage[];
  rawPackages: WorkspacePackage[];
}

export type WorkspacePackagesProvider = (
  config: ResolvedLiminaConfig,
) => Promise<WorkspacePackage[]>;

export async function collectWorkspaceRegionTopology(
  config: ResolvedLiminaConfig,
  options: {
    provider: WorkspacePackagesProvider;
    rawPackages?: readonly WorkspacePackage[];
  },
): Promise<WorkspaceRegionTopology> {
  const rawPackages = options.rawPackages
    ? [...options.rawPackages]
    : await options.provider(config);
  return collectValidatedWorkspaceContext({ config, rawPackages });
}

export async function collectWorkspaceRegionBoundaries(
  config: ResolvedLiminaConfig,
  provider: WorkspacePackagesProvider,
): Promise<WorkspaceRegionBoundary[]> {
  return (await collectWorkspaceRegionTopology(config, { provider }))
    .boundaries;
}
