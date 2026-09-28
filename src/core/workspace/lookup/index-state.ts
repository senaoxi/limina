import {
  isNamedWorkspacePackage,
  type NamedWorkspacePackage,
  type PackageOwner,
  type WorkspacePackage,
} from '#core/workspace/actions';
import { normalizeAbsolutePath } from '#utils/path';
import path from 'pathe';
import { GovernedDirectoryLookup } from './directory';
import { WorkspaceImporterLookup } from './importer';
import { WorkspacePackageScopeLookup } from './package-scope';
import { WorkspaceLookupRegion } from './region';
import { createDirectoryMap } from './shared';
import { ResolvedPackageTargetLookup } from './target';
import type { WorkspaceLookupIndexOptions } from './types';

export interface WorkspaceLookupState {
  importerLookup: WorkspaceImporterLookup;
  namedPackagesByName: Map<string, NamedWorkspacePackage>;
  ownerLookup: GovernedDirectoryLookup<PackageOwner>;
  packageLookup: GovernedDirectoryLookup<WorkspacePackage>;
  packageScopeLookup: WorkspacePackageScopeLookup;
  region: WorkspaceLookupRegion;
  targetLookup: ResolvedPackageTargetLookup;
}

function createNamedPackagesByName(
  packages: readonly WorkspacePackage[],
): Map<string, NamedWorkspacePackage> {
  const byName = new Map<string, NamedWorkspacePackage>();

  for (const workspacePackage of packages.filter(isNamedWorkspacePackage)) {
    if (!byName.has(workspacePackage.name)) {
      byName.set(workspacePackage.name, workspacePackage);
    }
  }

  return byName;
}

function createPackagesByPackageJsonPath(
  packages: readonly WorkspacePackage[],
): Map<string, WorkspacePackage> {
  return new Map(
    packages.map((workspacePackage) => [
      normalizeAbsolutePath(
        path.join(workspacePackage.directory, 'package.json'),
      ),
      workspacePackage,
    ]),
  );
}

function selectActivatedItems<T extends { directory: string }>(
  items: readonly T[],
  region: WorkspaceLookupRegion,
): T[] {
  return items.filter((item) => region.hasActivatedPackage(item.directory));
}

export function createWorkspaceLookupState(
  options: WorkspaceLookupIndexOptions,
): WorkspaceLookupState {
  const region = new WorkspaceLookupRegion(options.rootDir, options.pathIndex);
  const packages = selectActivatedItems(options.packages, region);
  const owners = selectActivatedItems(options.owners, region);
  const namedPackagesByName = createNamedPackagesByName(packages);
  const packageLookup = new GovernedDirectoryLookup({
    itemsByDirectory: createDirectoryMap(packages),
    kind: 'package',
    metrics: options.metrics,
    region,
  });
  const ownerLookup = new GovernedDirectoryLookup({
    itemsByDirectory: createDirectoryMap(owners),
    kind: 'owner',
    metrics: options.metrics,
    region,
  });
  const packageScopeLookup = new WorkspacePackageScopeLookup({
    namedPackagesByName,
    packagesByPackageJsonPath: createPackagesByPackageJsonPath(packages),
    region,
  });

  return {
    importerLookup: new WorkspaceImporterLookup({
      importers: options.importers,
      metrics: options.metrics,
      region,
    }),
    namedPackagesByName,
    ownerLookup,
    packageLookup,
    packageScopeLookup,
    region,
    targetLookup: new ResolvedPackageTargetLookup({
      metrics: options.metrics,
      ownerLookup,
      packageScopeLookup,
    }),
  };
}
