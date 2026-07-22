import type { ResolvedLiminaConfig } from '#config/runner';
import type { WorkspacePackage } from './actions';
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

export interface PnpmWorkspaceInspection {
  reason: string;
  status: 'excluded';
}

export interface PnpmWorkspaceRegionBoundary
  extends WorkspaceRegionBoundaryBase {
  inspection: PnpmWorkspaceInspection;
  kind: 'pnpm-workspace';
  workspaceYamlPath: string;
}

export type WorkspaceRegionBoundary =
  | PackageScopeRegionBoundary
  | PnpmWorkspaceRegionBoundary;

export function getWorkspaceRegionBoundaryExclusionReason(
  boundary: WorkspaceRegionBoundary,
): string | null {
  return boundary.kind === 'pnpm-workspace'
    ? boundary.inspection.reason
    : boundary.excluded
      ? (boundary.exclusionReason ?? null)
      : null;
}

export function isWorkspaceRegionBoundaryExcluded(
  boundary: WorkspaceRegionBoundary,
): boolean {
  return boundary.kind === 'pnpm-workspace' || boundary.excluded;
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
