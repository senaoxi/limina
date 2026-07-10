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

export class WorkspaceCore {
  readonly #config: ResolvedLiminaConfig;
  #importersPromise: Promise<ImporterInfo[]> | undefined;
  #ownersPromise: Promise<PackageOwner[]> | undefined;
  #topologyPromise: Promise<WorkspaceRegionTopology> | undefined;
  #workspaceDependenciesPromise:
    | Promise<WorkspaceDependencyDeclaration[]>
    | undefined;

  constructor(config: ResolvedLiminaConfig) {
    this.#config = config;
  }

  get rootDir(): string {
    return this.#config.rootDir;
  }

  invalidate(): void {
    this.#importersPromise = undefined;
    this.#ownersPromise = undefined;
    this.#topologyPromise = undefined;
    this.#workspaceDependenciesPromise = undefined;
  }

  getRawPackages(): Promise<WorkspacePackage[]> {
    return this.getRegionTopology().then((topology) =>
      cloneWorkspacePackages(topology.rawPackages),
    );
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
    this.#topologyPromise ??= collectWorkspaceRegionTopology(this.#config, {
      provider: collectRawWorkspacePackages,
    }).then(cloneWorkspaceRegionTopology);

    return this.#topologyPromise.then(cloneWorkspaceRegionTopology);
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
        workspacePackages: cloneWorkspacePackages(boundary.workspacePackages),
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
