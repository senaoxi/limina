import type { PackageOwner, WorkspacePackage } from '#core/workspace/actions';
import { uniqueSortedStrings } from '#utils/collections';
import { isPathInsideDirectory } from '#utils/path';
import type { BuildGraphCore } from './build-graph';
import type { WorkspaceDependencyDeclaration } from './packages/authority';
import type { ResolvedPackageTarget } from './packages/owners';
import type { TsconfigCore } from './tsconfig';
import type { WorkspaceCore } from './workspace';
import { createWorkspaceLookupIndex } from './workspace/lookup';

export interface PackageDomain {
  owner: PackageOwner | null;
  package: WorkspacePackage;
  sourceConfigPaths: string[];
  sourceModulePaths: string[];
}

export class PackageDomainCore {
  readonly #buildGraph: BuildGraphCore;
  readonly #tsconfig: TsconfigCore;
  readonly #workspace: WorkspaceCore;
  #domainCache = new Map<string, Promise<PackageDomain>>();

  constructor(options: {
    buildGraph: BuildGraphCore;
    tsconfig: TsconfigCore;
    workspace: WorkspaceCore;
  }) {
    this.#buildGraph = options.buildGraph;
    this.#tsconfig = options.tsconfig;
    this.#workspace = options.workspace;
  }

  invalidate(): void {
    this.#domainCache.clear();
  }

  async getPackageDomain(packageName: string): Promise<PackageDomain> {
    const cached = this.#domainCache.get(packageName);

    if (cached) {
      return clonePackageDomain(await cached);
    }

    const promise = this.#createPackageDomain(packageName);

    this.#domainCache.set(packageName, promise);

    return clonePackageDomain(await promise);
  }

  async findOwner(filePath: string): Promise<PackageOwner | null> {
    const owner = (await this.#createWorkspaceLookupIndex()).findOwnerForFile(
      filePath,
    );

    return owner ? clonePackageOwner(owner) : null;
  }

  async classifyResolvedPackageTarget(options: {
    owner: PackageOwner;
    resolvedFilePath: string;
  }): Promise<ResolvedPackageTarget> {
    return (
      await this.#createWorkspaceLookupIndex()
    ).classifyResolvedPackageTarget({
      owner: options.owner,
      resolvedFilePath: options.resolvedFilePath,
    });
  }

  getDependencyDeclarations(): Promise<WorkspaceDependencyDeclaration[]> {
    return this.#workspace.getWorkspaceDependencyDeclarations();
  }

  async #createWorkspaceLookupIndex() {
    const [importers, owners, packages, regionBoundaries] = await Promise.all([
      this.#workspace.getImporters(),
      this.#workspace.getPackageOwners(),
      this.#workspace.getPackages(),
      this.#workspace.getRegionBoundaries(),
    ]);

    return createWorkspaceLookupIndex({
      importers,
      owners,
      packages,
      regionBoundaries,
      rootDir: this.#workspace.rootDir,
    });
  }

  async #createPackageDomain(packageName: string): Promise<PackageDomain> {
    const [packages, owners, graph] = await Promise.all([
      this.#workspace.getPackages(),
      this.#workspace.getPackageOwners(),
      this.#buildGraph.getGraph(),
    ]);
    const workspacePackage = packages.find(
      (candidate) => candidate.name === packageName,
    );

    if (!workspacePackage) {
      throw new Error(`Workspace package "${packageName}" was not found.`);
    }

    const owner =
      owners.find((candidate) =>
        isPathInsideDirectory(workspacePackage.directory, candidate.directory),
      ) ?? null;
    const sourceConfigPaths = uniqueSortedStrings(
      [...graph.sourceToDts.values()].flatMap((sourceToDts) => [
        ...sourceToDts.keys(),
      ]),
    ).filter((configPath) =>
      isPathInsideDirectory(configPath, workspacePackage.directory),
    );
    const projects = await Promise.all(
      sourceConfigPaths.map((configPath) =>
        this.#tsconfig.getProject(configPath),
      ),
    );
    const sourceModulePaths = uniqueSortedStrings(
      projects.flatMap((project) => project.ownedFileNames),
    ).filter((filePath) =>
      isPathInsideDirectory(filePath, workspacePackage.directory),
    );

    return {
      owner,
      package: workspacePackage,
      sourceConfigPaths,
      sourceModulePaths,
    };
  }
}

function clonePackageDomain(domain: PackageDomain): PackageDomain {
  return {
    owner: domain.owner ? clonePackageOwner(domain.owner) : null,
    package: {
      ...domain.package,
      manifest: { ...domain.package.manifest },
    },
    sourceConfigPaths: [...domain.sourceConfigPaths],
    sourceModulePaths: [...domain.sourceModulePaths],
  };
}

function clonePackageOwner(owner: PackageOwner): PackageOwner {
  return {
    ...owner,
    manifest: { ...owner.manifest },
  };
}
