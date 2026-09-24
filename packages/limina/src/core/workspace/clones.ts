import type { WorkspaceDependencyDeclaration } from '../packages/authority';
import type {
  ImporterInfo,
  PackageManifest,
  PackageOwner,
  WorkspacePackage,
} from '../workspace/actions';
import type {
  WorkspaceRegionBoundary,
  WorkspaceRegionTopology,
} from './regions';
import type { ValidatedWorkspaceContext } from './validated-context';

/** Immutable root manifests remain the shared fact for this resolution generation. */
function cloneManifest(manifest: PackageManifest): PackageManifest {
  return Object.isFrozen(manifest) ? manifest : { ...manifest };
}

export function cloneWorkspacePackage(
  workspacePackage: WorkspacePackage,
): WorkspacePackage {
  return {
    ...workspacePackage,
    manifest: cloneManifest(workspacePackage.manifest),
  };
}

export function cloneWorkspacePackages(
  packages: WorkspacePackage[],
): WorkspacePackage[] {
  return packages.map(cloneWorkspacePackage);
}

function cloneWorkspaceRegionBoundary(
  boundary: WorkspaceRegionBoundary,
): WorkspaceRegionBoundary {
  return boundary.kind === 'workspace-root'
    ? {
        ...boundary,
        inspection: { ...boundary.inspection },
        descriptor: { ...boundary.descriptor },
      }
    : { ...boundary };
}

export function cloneWorkspaceRegionBoundaries(
  boundaries: WorkspaceRegionBoundary[],
): WorkspaceRegionBoundary[] {
  return boundaries.map(cloneWorkspaceRegionBoundary);
}

export function cloneWorkspaceRegionTopology(
  topology: WorkspaceRegionTopology,
): WorkspaceRegionTopology {
  return {
    boundaries: cloneWorkspaceRegionBoundaries(topology.boundaries),
    extendedPackageScopes: topology.extendedPackageScopes.map((scope) => ({
      ...scope,
    })),
    packages: cloneWorkspacePackages(topology.packages),
    rawPackages: cloneWorkspacePackages(topology.rawPackages),
  };
}

export function cloneValidatedWorkspaceContext(
  context: ValidatedWorkspaceContext,
): ValidatedWorkspaceContext {
  return {
    ...cloneWorkspaceRegionTopology(context),
    configRootDir: context.configRootDir,
    descriptorCandidates: context.descriptorCandidates.map((candidate) => ({
      ...candidate,
    })),
    outputRoots: [...context.outputRoots],
    ...(context.outputMutationAuthorities
      ? {
          outputMutationAuthorities: new Map(context.outputMutationAuthorities),
        }
      : {}),
    packageIdentities: context.packageIdentities.map((identity) => ({
      ...identity,
      package: cloneWorkspacePackage(identity.package),
    })),
    sourceConfigPaths: [...context.sourceConfigPaths],
    workspaceRootDir: context.workspaceRootDir,
    governanceRoot: context.governanceRoot,
    ...(context.workspaceMutationGeneration
      ? {
          workspaceMutationGeneration: context.workspaceMutationGeneration,
        }
      : {}),
  };
}

export function clonePackageOwner(owner: PackageOwner): PackageOwner {
  return {
    ...owner,
    manifest: cloneManifest(owner.manifest),
  };
}

export function clonePackageOwners(owners: PackageOwner[]): PackageOwner[] {
  return owners.map(clonePackageOwner);
}

export function cloneImporterInfo(importer: ImporterInfo): ImporterInfo {
  return {
    ...importer,
    declaredWorkspaceDependencies: new Set(
      importer.declaredWorkspaceDependencies,
    ),
  };
}

export function cloneWorkspaceDependencyDeclaration(
  declaration: WorkspaceDependencyDeclaration,
): WorkspaceDependencyDeclaration {
  return {
    ...declaration,
    importer: cloneWorkspacePackage(declaration.importer),
  };
}
