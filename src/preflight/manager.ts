import type { ResolvedLiminaConfig } from '#config/runner';
import { type AnalysisProviderSet, createAnalysisProviders } from '#core';
import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
import type { ImportAnalysisContext } from '#core/import-analysis/runner';
import {
  type CheckerRouteSnapshotCollection,
  type CollectCheckerGraphProjectRoutesResult,
  collectCheckerRouteSnapshot,
  type CollectSourceGraphProjectExtensionsResult,
  projectCheckerEntryProjectRoutes,
  projectGraphProjectRoutes,
  projectSourceGraphProjectExtensions,
} from '#core/tsconfig/actions';
import type {
  ImporterInfo,
  PackageOwner,
  WorkspacePackage,
} from '#core/workspace/actions';
import {
  type AnalysisMetricsRecorder,
  type AnalysisRun,
  createAnalysisRun,
} from '../application/analysis/analysis-run';
import { materializeGeneratedArtifactPlan } from '../core/build-graph/materializer';
import type { WorkspaceDependencyDeclaration } from '../core/packages/authority';
import type { WorkspaceLookupIndex } from '../core/workspace/lookup';
import type { WorkspaceRegionBoundary } from '../core/workspace/regions';
import type {
  ValidatedWorkspaceContext,
  WorkspaceRegionPathIndex,
} from '../core/workspace/validated-context';
import {
  createLiminaArtifactNamespace,
  type LiminaArtifactNamespace,
} from '../domain/artifacts/namespace';
import { identifier } from '../domain/shared/identifiers';
import {
  createPackageEntrySelectionPlan,
  type PackageEntrySelectionPlan,
} from '../package-check/entry/selection';
import { collectExpectedSourceFiles } from '../proof/source-files';
import { PreflightGenerationCache } from './cache';
import { registerPreflightGenerationAdvancer } from './generation';
import { ensureMaterialization } from './materialization';
import {
  resolveArtifactNamespace,
  resolveMetrics,
  resolveProviders,
  resolveSignal,
} from './setup';
import type {
  LiminaPreflightManagerOptions,
  MaterializationReceipt,
  PackageEntryPlanOptions,
} from './types';
export class LiminaPreflightManager {
  artifactNamespace: LiminaArtifactNamespace;
  readonly config: ResolvedLiminaConfig;
  providers: AnalysisProviderSet;
  run: AnalysisRun;
  readonly #generatedGraphProvider:
    | (() => Promise<GeneratedTsconfigGraphResult>)
    | undefined;
  readonly #metrics: AnalysisMetricsRecorder;
  readonly #profilingMetrics: AnalysisMetricsRecorder | undefined;
  readonly #signal: AbortSignal;
  #cache = new PreflightGenerationCache(0);
  #generation = 0;
  #providerGeneration = 0;
  readonly #usesCustomProviders: boolean;
  #disposed = false;
  constructor(options: LiminaPreflightManagerOptions) {
    this.config = options.config;
    this.#generatedGraphProvider = options.generatedGraphProvider;
    this.#metrics = resolveMetrics(options);
    this.#profilingMetrics = options.metrics;
    this.#signal = resolveSignal(options);
    this.#usesCustomProviders = options.providers !== undefined;
    this.artifactNamespace = resolveArtifactNamespace(options);
    this.providers = resolveProviders({
      artifactNamespace: this.artifactNamespace,
      managerOptions: options,
    });
    this.run = this.#createRun();
    registerPreflightGenerationAdvancer(this, () =>
      this.#startNextGeneration(),
    );
  }
  get profilingMetrics(): AnalysisMetricsRecorder | undefined {
    return this.#profilingMetrics;
  }
  dispose(): void {
    if (this.#disposed) {
      return;
    }

    this.#disposed = true;
    this.providers.dispose?.();
  }
  ensureGeneratedGraph(): Promise<GeneratedTsconfigGraphResult> {
    if (this.#cache.generatedGraph === undefined) {
      const providers = this.providers;
      const generatedGraphProvider = this.#generatedGraphProvider;
      this.#cache.generatedGraph = this.ensureWorkspaceValidated().then(
        () => generatedGraphProvider?.() ?? providers.buildGraph.getGraph(),
      );
    }
    return this.#cache.generatedGraph;
  }
  ensureWorkspaceValidated(): Promise<ValidatedWorkspaceContext> {
    this.#cache.validatedWorkspaceContext ??=
      this.providers.workspace.getValidatedContext();
    return this.#cache.validatedWorkspaceContext;
  }
  ensureGeneratedArtifactsMaterialized(): Promise<MaterializationReceipt> {
    const slot = this.#cache.materializationSlot;
    const artifactNamespace = this.artifactNamespace;
    const metrics = this.run.metrics;

    return ensureMaterialization({
      getCurrentSlot: () => this.#cache.materializationSlot,
      materialize: async () => {
        let graph = await this.ensureGeneratedGraph();
        const materialized = await materializeGeneratedArtifactPlan(
          artifactNamespace,
          graph.artifactPlan,
          {
            metrics,
            replan: async () => {
              this.#refreshProviderGenerationForMaterialization();
              graph = await this.ensureGeneratedGraph();
              return {
                namespace: this.artifactNamespace,
                plan: graph.artifactPlan,
              };
            },
          },
        );
        if (materialized.plan !== graph.artifactPlan) {
          throw new Error(
            'Materialization selected a plan outside the preflight graph generation.',
          );
        }
        return { changed: graph.changed, generation: slot.generation, graph };
      },
      slot,
    });
  }
  ensureWorkspacePackages(): Promise<WorkspacePackage[]> {
    this.#cache.workspacePackages ??= this.ensureWorkspaceValidated().then(
      (context) =>
        context.packages.map((workspacePackage) => ({
          ...workspacePackage,
          manifest: { ...workspacePackage.manifest },
        })),
    );
    return this.#cache.workspacePackages;
  }
  ensureRawWorkspacePackages(): Promise<WorkspacePackage[]> {
    this.#cache.rawWorkspacePackages ??=
      this.providers.workspace.getRawPackages();
    return this.#cache.rawWorkspacePackages;
  }
  ensurePackageOwners(): Promise<PackageOwner[]> {
    this.#cache.packageOwners ??= this.providers.workspace.getPackageOwners();
    return this.#cache.packageOwners;
  }
  ensureImporters(): Promise<ImporterInfo[]> {
    this.#cache.importers ??= this.providers.workspace.getImporters();
    return this.#cache.importers;
  }
  ensureWorkspaceLookupIndex(): Promise<WorkspaceLookupIndex> {
    this.#cache.workspaceLookup ??= this.providers.workspace.getLookupIndex();
    return this.#cache.workspaceLookup;
  }
  ensureWorkspacePathIndex(): Promise<WorkspaceRegionPathIndex> {
    return this.providers.workspace.getPathIndex();
  }
  ensureWorkspaceDependencyDeclarations(): Promise<
    WorkspaceDependencyDeclaration[]
  > {
    this.#cache.workspaceDependencies ??=
      this.providers.workspace.getWorkspaceDependencyDeclarations();
    return this.#cache.workspaceDependencies;
  }
  ensureWorkspaceRegionBoundaries(): Promise<WorkspaceRegionBoundary[]> {
    this.#cache.workspaceRegionBoundaries ??=
      this.providers.workspace.getRegionBoundaries();
    return this.#cache.workspaceRegionBoundaries;
  }
  async ensureSourceGraphProjectExtensions(): Promise<CollectSourceGraphProjectExtensionsResult> {
    this.#cache.sourceGraphProjectExtensions ??= Promise.all([
      this.#ensureCheckerRouteSnapshot(),
      this.ensureGeneratedGraph(),
    ]).then(([snapshot, generatedGraph]) =>
      projectSourceGraphProjectExtensions(
        this.config,
        snapshot,
        generatedGraph,
      ),
    );
    return this.#cache.sourceGraphProjectExtensions;
  }
  async ensureGraphProjectRoutes(): Promise<CollectCheckerGraphProjectRoutesResult> {
    this.#cache.graphProjectRoutes ??= this.#ensureCheckerRouteSnapshot().then(
      (snapshot) => projectGraphProjectRoutes(this.config, snapshot),
    );
    return this.#cache.graphProjectRoutes;
  }
  async ensureCheckerEntryProjectRoutes(): Promise<CollectCheckerGraphProjectRoutesResult> {
    this.#cache.checkerEntryProjectRoutes ??=
      this.#ensureCheckerRouteSnapshot().then((snapshot) =>
        projectCheckerEntryProjectRoutes(this.config, snapshot),
      );
    return this.#cache.checkerEntryProjectRoutes;
  }
  ensureExpectedSourceFiles(): Promise<Set<string>> {
    this.#cache.expectedSourceFiles ??= Promise.all([
      this.ensureGeneratedGraph(),
      this.ensureWorkspaceValidated(),
    ]).then(([graph, context]) =>
      collectExpectedSourceFiles(this.config, graph, context),
    );
    return this.#cache.expectedSourceFiles;
  }
  async ensurePackageEntrySelectionPlan(
    options: PackageEntryPlanOptions,
  ): Promise<PackageEntrySelectionPlan> {
    const context = await this.ensureWorkspaceValidated();
    return createPackageEntrySelectionPlan({
      config: this.config,
      cwd: options.cwd,
      packageNames: options.packageNames,
      requireCwdPackageMatch: options.requireCwdPackageMatch,
      tool: options.tool,
      workspaceContext: context,
    });
  }
  get importAnalysis(): ImportAnalysisContext {
    return this.providers.imports.context;
  }
  #ensureCheckerRouteSnapshot(): Promise<CheckerRouteSnapshotCollection> {
    this.#cache.checkerRouteSnapshot ??= this.ensureGeneratedGraph().then(
      (graph) =>
        collectCheckerRouteSnapshot(this.config, graph, this.run.metrics),
    );
    return this.#cache.checkerRouteSnapshot;
  }
  #startNextGeneration(): void {
    this.#replaceProviderGeneration(true);
  }
  #assertDefaultProvidersCanAdvance(): void {
    if (!this.#usesCustomProviders) return;
    throw new Error(
      'Custom analysis providers support generation 0 only and cannot advance.',
    );
  }
  #refreshProviderGenerationForMaterialization(): void {
    this.#replaceProviderGeneration(false, this.#cache.materializationSlot);
  }
  #replaceProviderGeneration(
    advance: boolean,
    slot?: PreflightGenerationCache['materializationSlot'],
  ): void {
    if (this.#disposed) {
      throw new Error('Preflight manager has been disposed.');
    }
    this.#assertDefaultProvidersCanAdvance();
    this.#disposeProviders();
    if (advance) this.#generation += 1;
    this.#providerGeneration += 1;
    this.#cache = new PreflightGenerationCache(this.#generation, slot);
    this.artifactNamespace = createLiminaArtifactNamespace({
      generation: this.#providerGeneration,
      rootDir: this.config.rootDir,
    });
    this.providers = createAnalysisProviders(
      this.config,
      this.artifactNamespace,
      this.#profilingMetrics,
    );
    this.run = this.#createRun();
  }

  #disposeProviders(): void {
    this.providers.dispose?.();
  }

  #createRun(): AnalysisRun {
    return createAnalysisRun({
      generation: identifier<'AnalysisGeneration'>(String(this.#generation)),
      metrics: this.#metrics,
      signal: this.#signal,
      snapshotToken: identifier<'RepositorySnapshotToken'>(
        `${this.config.rootDir}:${this.#generation}:${this.#providerGeneration}`,
      ),
    });
  }
}
