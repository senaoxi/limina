import type { ResolvedLiminaConfig } from '#config/runner';
import {
  collectImporters,
  collectRawWorkspacePackages,
  findPackageForSpecifier,
  type ImporterInfo,
  type NamedWorkspacePackage,
  type PackageOwner,
  type WorkspacePackage,
} from '#core/workspace/actions';
import path from 'pathe';
import {
  collectWorkspaceDependencyDeclarations,
  type WorkspaceDependencyDeclaration,
} from './packages/authority';
import {
  collectWorkspaceRegionTopology,
  type WorkspaceRegionBoundary,
  type WorkspaceRegionTopology,
} from './workspace/regions';
import type { ValidatedWorkspaceContext } from './workspace/validated-context';

export class WorkspaceCore {
  readonly #config: ResolvedLiminaConfig;
  #importersPromise: Promise<ImporterInfo[]> | undefined;
  #ownersPromise: Promise<PackageOwner[]> | undefined;
  #rawPackagesPromise: Promise<WorkspacePackage[]> | undefined;
  #topologyPromise: Promise<ValidatedWorkspaceContext> | undefined;
  #workspaceDependenciesPromise:
    | Promise<WorkspaceDependencyDeclaration[]>
    | undefined;

  constructor(config: ResolvedLiminaConfig) {
    this.#config = config;
  }

  get rootDir(): string {
    return this.#config.rootDir;
  }

  getRawPackages(): Promise<WorkspacePackage[]> {
    this.#rawPackagesPromise ??= collectRawWorkspacePackages(this.#config);
    return this.#rawPackagesPromise.then(cloneWorkspacePackages);
  }

  getPackages(): Promise<WorkspacePackage[]> {
    return this.getRegionTopology().then((topology) =>
      cloneWorkspacePackages(topology.packages),
    );
  }

  getRegionBoundaries(): Promise<WorkspaceRegionBoundary[]> {
    return this.getRegionTopology().then((topology) =>
      cloneWorkspaceRegionBoundaries(topology.boundaries),
    );
  }

  getRegionTopology(): Promise<WorkspaceRegionTopology> {
    return this.getValidatedContext().then(cloneWorkspaceRegionTopology);
  }

  getValidatedContext(): Promise<ValidatedWorkspaceContext> {
    this.#topologyPromise ??= this.getRawPackages()
      .then((rawPackages) =>
        collectWorkspaceRegionTopology(this.#config, {
          provider: collectRawWorkspacePackages,
          rawPackages,
        }),
      )
      .then((topology) =>
        cloneValidatedWorkspaceContext(topology as ValidatedWorkspaceContext),
      );

    return this.#topologyPromise.then(cloneValidatedWorkspaceContext);
  }

  getPackageOwners(): Promise<PackageOwner[]> {
    this.#ownersPromise ??= this.getPackages().then((packages) =>
      packages
        .map((workspacePackage) => ({
          directory: workspacePackage.directory,
          manifest: workspacePackage.manifest,
          ...(workspacePackage.name ? { name: workspacePackage.name } : {}),
          packageJsonPath: path.join(
            workspacePackage.directory,
            'package.json',
          ),
        }))
        .sort((left, right) => right.directory.length - left.directory.length)
        .map(clonePackageOwner),
    );

    return this.#ownersPromise.then(clonePackageOwners);
  }

  async findPackageBySpecifier(
    specifier: string,
  ): Promise<WorkspacePackage | null> {
    const workspacePackage = findPackageForSpecifier(
      specifier,
      await this.getPackages(),
    );

    return workspacePackage ? cloneWorkspacePackage(workspacePackage) : null;
  }

  async getImporters(): Promise<ImporterInfo[]> {
    this.#importersPromise ??= this.getPackages().then((packages) =>
      collectImporters(this.#config, packages).map(cloneImporterInfo),
    );

    return this.#importersPromise.then((importers) =>
      importers.map(cloneImporterInfo),
    );
  }

  async getWorkspaceDependencyDeclarations(): Promise<
    WorkspaceDependencyDeclaration[]
  > {
    this.#workspaceDependenciesPromise ??= this.getPackages().then((packages) =>
      collectWorkspaceDependencyDeclarations(packages).map(
        cloneWorkspaceDependencyDeclaration,
      ),
    );

    return this.#workspaceDependenciesPromise.then((declarations) =>
      declarations.map(cloneWorkspaceDependencyDeclaration),
    );
  }
}

function cloneWorkspacePackage(
  workspacePackage: WorkspacePackage,
): WorkspacePackage {
  return {
    ...workspacePackage,
    manifest: { ...workspacePackage.manifest },
  };
}

function cloneWorkspacePackages(
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

function cloneWorkspaceRegionBoundaries(
  boundaries: WorkspaceRegionBoundary[],
): WorkspaceRegionBoundary[] {
  return boundaries.map(cloneWorkspaceRegionBoundary);
}

function cloneWorkspaceRegionTopology(
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

function cloneValidatedWorkspaceContext(
  context: ValidatedWorkspaceContext,
): ValidatedWorkspaceContext {
  return {
    ...cloneWorkspaceRegionTopology(context),
    configRootDir: context.configRootDir,
    descriptorCandidates: context.descriptorCandidates.map((candidate) => ({
      ...candidate,
    })),
    outputRoots: [...context.outputRoots],
    packageIdentities: context.packageIdentities.map((identity) => ({
      ...identity,
      package: cloneWorkspacePackage(identity.package),
    })),
    sourceConfigPaths: [...context.sourceConfigPaths],
    workspaceRootDir: context.workspaceRootDir,
  };
}

function cloneNamedWorkspacePackage(
  workspacePackage: NamedWorkspacePackage,
): NamedWorkspacePackage {
  return cloneWorkspacePackage(workspacePackage) as NamedWorkspacePackage;
}

function clonePackageOwner(owner: PackageOwner): PackageOwner {
  return {
    ...owner,
    manifest: { ...owner.manifest },
  };
}

function clonePackageOwners(owners: PackageOwner[]): PackageOwner[] {
  return owners.map(clonePackageOwner);
}

function cloneImporterInfo(importer: ImporterInfo): ImporterInfo {
  return {
    ...importer,
    declaredWorkspaceDependencies: new Set(
      importer.declaredWorkspaceDependencies,
    ),
  };
}

function cloneWorkspaceDependencyDeclaration(
  declaration: WorkspaceDependencyDeclaration,
): WorkspaceDependencyDeclaration {
  return {
    ...declaration,
    importer: cloneNamedWorkspacePackage(declaration.importer),
  };
}
