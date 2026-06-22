import type { ResolvedLiminaConfig } from '#config/runner';
import {
  collectImporters,
  collectPackageOwners,
  collectWorkspacePackages,
  findPackageForSpecifier,
  type ImporterInfo,
  type NamedWorkspacePackage,
  type PackageOwner,
  type WorkspacePackage,
} from '#core/workspace/actions';
import {
  collectWorkspaceDependencyDeclarations,
  type WorkspaceDependencyDeclaration,
} from './packages/authority';

export class WorkspaceCore {
  readonly #config: ResolvedLiminaConfig;
  #importersPromise: Promise<ImporterInfo[]> | undefined;
  #ownersPromise: Promise<PackageOwner[]> | undefined;
  #packagesPromise: Promise<WorkspacePackage[]> | undefined;
  #workspaceDependenciesPromise:
    | Promise<WorkspaceDependencyDeclaration[]>
    | undefined;

  constructor(config: ResolvedLiminaConfig) {
    this.#config = config;
  }

  invalidate(): void {
    this.#importersPromise = undefined;
    this.#ownersPromise = undefined;
    this.#packagesPromise = undefined;
    this.#workspaceDependenciesPromise = undefined;
  }

  getPackages(): Promise<WorkspacePackage[]> {
    this.#packagesPromise ??= collectWorkspacePackages(this.#config).then(
      cloneWorkspacePackages,
    );

    return this.#packagesPromise.then(cloneWorkspacePackages);
  }

  getPackageOwners(): Promise<PackageOwner[]> {
    this.#ownersPromise ??= collectPackageOwners(this.#config).then(
      clonePackageOwners,
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
