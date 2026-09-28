import type { PackageOwner, WorkspacePackage } from '#core/workspace/actions';
import { uniqueCodeUnitSortedStrings as uniqueSortedStrings } from '#utils/collections';
import { isPathInsideDirectory } from '#utils/path';
import type { BuildGraphCore } from './build-graph';
import { collectGovernedSourceConfigPaths } from './build-graph/runner';
import type { WorkspaceDependencyDeclaration } from './packages/authority';
import type { ResolvedPackageTarget } from './packages/owners';
import type { WorkspaceCore } from './workspace';

export interface PackageDomain {
  owner: PackageOwner | null;
  package: WorkspacePackage;
  sourceConfigPaths: string[];
  sourceModulePaths: string[];
}

export class PackageDomainCore {
  readonly #buildGraph: BuildGraphCore;
  readonly #workspace: WorkspaceCore;
  #domainCache = new Map<string, Promise<PackageDomain>>();

  constructor(options: {
    buildGraph: BuildGraphCore;
    workspace: WorkspaceCore;
  }) {
    this.#buildGraph = options.buildGraph;
    this.#workspace = options.workspace;
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
    const owner = (await this.#workspace.getLookupIndex()).findOwnerForFile(
      filePath,
    );

    return owner ? clonePackageOwner(owner) : null;
  }

  async classifyResolvedPackageTarget(options: {
    owner: PackageOwner;
    resolvedFilePath: string;
  }): Promise<ResolvedPackageTarget> {
    return (
      await this.#workspace.getLookupIndex()
    ).classifyResolvedPackageTarget({
      owner: options.owner,
      resolvedFilePath: options.resolvedFilePath,
    });
  }

  getDependencyDeclarations(): Promise<WorkspaceDependencyDeclaration[]> {
    return this.#workspace.getWorkspaceDependencyDeclarations();
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
    const sourceConfigPaths = collectGovernedSourceConfigPaths(graph).filter(
      (configPath) =>
        isPathInsideDirectory(configPath, workspacePackage.directory),
    );
    const sourceModulePaths = uniqueSortedStrings(
      [...graph.governedSources.values()].flatMap((governedSources) =>
        [...governedSources.values()].flatMap((unit) => unit.ownedFileNames),
      ),
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
