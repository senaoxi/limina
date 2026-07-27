import type { WorkspaceDependencyDeclaration } from '../packages/authority';
import type {
  ImporterInfo,
  NamedWorkspacePackage,
  PackageOwner,
  WorkspacePackage,
} from '../workspace/actions';
import type {
  WorkspaceRegionBoundary,
  WorkspaceRegionTopology,
} from './regions';
import type { ValidatedWorkspaceContext } from './validated-context';

export function cloneWorkspacePackage(
  workspacePackage: WorkspacePackage,
): WorkspacePackage {
  return {
    ...workspacePackage,
    manifest: { ...workspacePackage.manifest },
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
  return boundary.kind === 'pnpm-workspace'
    ? {
        ...boundary,
        inspection: { ...boundary.inspection },
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
    ...(context.workspaceMutationGeneration
      ? {
          workspaceMutationGeneration: context.workspaceMutationGeneration,
        }
      : {}),
  };
}

function cloneNamedWorkspacePackage(
  workspacePackage: NamedWorkspacePackage,
): NamedWorkspacePackage {
  return cloneWorkspacePackage(workspacePackage) as NamedWorkspacePackage;
}

export function clonePackageOwner(owner: PackageOwner): PackageOwner {
  return {
    ...owner,
    manifest: { ...owner.manifest },
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
    importer: cloneNamedWorkspacePackage(declaration.importer),
  };
}
