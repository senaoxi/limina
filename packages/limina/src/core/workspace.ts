import type { ResolvedLiminaConfig } from '#config/runner';
import {
  collectImporters,
  collectRawWorkspacePackages,
  findPackageForSpecifier,
  type ImporterInfo,
  type PackageOwner,
  type WorkspacePackage,
} from '#core/workspace/actions';
import path from 'pathe';
import {
  collectWorkspaceDependencyDeclarations,
  type WorkspaceDependencyDeclaration,
} from './packages/authority';
import { mapPromise } from './promise';
import {
  cloneImporterInfo,
  clonePackageOwner,
  clonePackageOwners,
  cloneValidatedWorkspaceContext,
  cloneWorkspaceDependencyDeclaration,
  cloneWorkspacePackage,
  cloneWorkspacePackages,
  cloneWorkspaceRegionBoundaries,
  cloneWorkspaceRegionTopology,
} from './workspace/clones';
import {
  createWorkspaceLookupIndex,
  type WorkspaceLookupIndex,
} from './workspace/lookup';
import {
  collectWorkspaceRegionTopology,
  type WorkspaceRegionBoundary,
  type WorkspaceRegionTopology,
} from './workspace/regions';
import {
  type ValidatedWorkspaceContext,
  WorkspaceRegionPathIndex,
} from './workspace/validated-context';

export interface WorkspaceCoreMetricsRecorder {
  record(measurement: {
    readonly count?: number;
    readonly kind?: string;
    readonly name:
      | 'canonical-path-cache-hit'
      | 'canonical-path-cache-miss'
      | 'canonical-path'
      | 'provider-cache-hit'
      | 'provider-cache-miss'
      | 'workspace-directory-index-entry'
      | 'workspace-importer-ancestor-visit'
      | 'workspace-negative-lookup'
      | 'workspace-path-trie-segment-visit'
      | 'workspace-path-classification-hit'
      | 'workspace-path-classification-miss';
    readonly provider?: string;
  }): void;
}

export interface WorkspaceCoreDependencies {
  readonly collectRawWorkspacePackages?: (
    config: ResolvedLiminaConfig,
  ) => Promise<WorkspacePackage[]>;
}

export class WorkspaceCore {
  readonly #collectRawWorkspacePackages: (
    config: ResolvedLiminaConfig,
  ) => Promise<WorkspacePackage[]>;

  readonly #config: ResolvedLiminaConfig;

  readonly #metrics: WorkspaceCoreMetricsRecorder | undefined;

  #importersPromise: Promise<ImporterInfo[]> | undefined;

  #lookupIndexPromise: Promise<WorkspaceLookupIndex> | undefined;

  #ownersPromise: Promise<PackageOwner[]> | undefined;

  #pathIndexPromise: Promise<WorkspaceRegionPathIndex> | undefined;

  #rawPackagesPromise: Promise<WorkspacePackage[]> | undefined;

  #topologyPromise: Promise<ValidatedWorkspaceContext> | undefined;

  #workspaceDependenciesPromise:
    | Promise<WorkspaceDependencyDeclaration[]>
    | undefined;

  constructor(
    config: ResolvedLiminaConfig,
    metrics?: WorkspaceCoreMetricsRecorder,
    dependencies: WorkspaceCoreDependencies = {},
  ) {
    this.#collectRawWorkspacePackages =
      dependencies.collectRawWorkspacePackages ?? collectRawWorkspacePackages;
    this.#config = config;
    this.#metrics = metrics;
  }

  #recordProviderCache(kind: 'hit' | 'miss', provider: string): void {
    this.#metrics?.record({
      kind: provider,
      name: kind === 'hit' ? 'provider-cache-hit' : 'provider-cache-miss',
      provider: 'workspace-core',
    });
  }

  get rootDir(): string {
    return this.#config.rootDir;
  }

  getRawPackages(): Promise<WorkspacePackage[]> {
    this.#rawPackagesPromise ??= this.#collectRawWorkspacePackages(
      this.#config,
    );
    return mapPromise(this.#rawPackagesPromise, cloneWorkspacePackages);
  }

  getPackages(): Promise<WorkspacePackage[]> {
    return mapPromise(this.getRegionTopology(), (topology) =>
      cloneWorkspacePackages(topology.packages),
    );
  }

  getRegionBoundaries(): Promise<WorkspaceRegionBoundary[]> {
    return mapPromise(this.getRegionTopology(), (topology) =>
      cloneWorkspaceRegionBoundaries(topology.boundaries),
    );
  }

  getRegionTopology(): Promise<WorkspaceRegionTopology> {
    return mapPromise(this.getValidatedContext(), cloneWorkspaceRegionTopology);
  }

  getValidatedContext(): Promise<ValidatedWorkspaceContext> {
    this.#topologyPromise ??= mapPromise(
      mapPromise(this.getRawPackages(), (rawPackages) =>
        collectWorkspaceRegionTopology(this.#config, {
          provider: collectRawWorkspacePackages,
          rawPackages,
        }),
      ),
      (topology) =>
        cloneValidatedWorkspaceContext(topology as ValidatedWorkspaceContext),
    );

    return mapPromise(this.#topologyPromise, cloneValidatedWorkspaceContext);
  }

  getPackageOwners(): Promise<PackageOwner[]> {
    this.#ownersPromise ??= mapPromise(this.getPackages(), (packages) =>
      packages
        .map((workspacePackage) => ({
          directory: workspacePackage.directory,
          manifest: workspacePackage.manifest,
          ...(workspacePackage.name && { name: workspacePackage.name }),
          packageJsonPath: path.join(
            workspacePackage.directory,
            'package.json',
          ),
        }))
        .sort((left, right) => right.directory.length - left.directory.length)
        .map(clonePackageOwner),
    );

    return mapPromise(this.#ownersPromise, clonePackageOwners);
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
    this.#importersPromise ??= mapPromise(this.getPackages(), (packages) =>
      collectImporters(this.#config, packages).map(cloneImporterInfo),
    );

    return mapPromise(this.#importersPromise, (importers) =>
      importers.map(cloneImporterInfo),
    );
  }

  async getWorkspaceDependencyDeclarations(): Promise<
    WorkspaceDependencyDeclaration[]
  > {
    this.#workspaceDependenciesPromise ??= mapPromise(
      this.getValidatedContext(),
      (context) =>
        collectWorkspaceDependencyDeclarations(context).map(
          cloneWorkspaceDependencyDeclaration,
        ),
    );

    return mapPromise(this.#workspaceDependenciesPromise, (declarations) =>
      declarations.map(cloneWorkspaceDependencyDeclaration),
    );
  }

  getPathIndex(): Promise<WorkspaceRegionPathIndex> {
    if (this.#pathIndexPromise) {
      this.#recordProviderCache('hit', 'workspace-path-index');
      return this.#pathIndexPromise;
    }

    this.#recordProviderCache('miss', 'workspace-path-index');
    this.#pathIndexPromise = mapPromise(
      this.getValidatedContext(),
      (context) => new WorkspaceRegionPathIndex(context, this.#metrics),
    );
    return this.#pathIndexPromise;
  }

  getLookupIndex(): Promise<WorkspaceLookupIndex> {
    if (this.#lookupIndexPromise) {
      this.#recordProviderCache('hit', 'workspace-lookup-index');
      return this.#lookupIndexPromise;
    }

    this.#recordProviderCache('miss', 'workspace-lookup-index');
    this.#lookupIndexPromise = mapPromise(
      Promise.all([
        this.getImporters(),
        this.getPackageOwners(),
        this.getPackages(),
        this.getPathIndex(),
      ]),
      ([importers, owners, packages, pathIndex]) =>
        createWorkspaceLookupIndex({
          importers,
          owners,
          packages,
          pathIndex,
          rootDir: this.rootDir,
          metrics: this.#metrics,
        }),
    );
    return this.#lookupIndexPromise;
  }
}
