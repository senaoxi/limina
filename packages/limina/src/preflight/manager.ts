import type { ResolvedLiminaConfig } from '#config/runner';
import { type AnalysisProviderSet, createAnalysisProviders } from '#core';
import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
import type { ImportAnalysisContext } from '#core/import-analysis/runner';
import type * as CheckerRoutes from '#core/tsconfig/actions';
import type * as Workspace from '#core/workspace/actions';
import type {
  AnalysisMetricsRecorder,
  AnalysisRun,
} from '../application/analysis/analysis-run';
import type { WorkspaceDependencyDeclaration } from '../core/packages/authority';
import type { WorkspaceLookupIndex } from '../core/workspace/lookup';
import type { WorkspaceRegionBoundary } from '../core/workspace/regions';
import type * as ValidatedWorkspace from '../core/workspace/validated-context';
import {
  createLiminaArtifactNamespace,
  type LiminaArtifactNamespace,
} from '../domain/artifacts/namespace';
import type { PackageEntrySelectionPlan } from '../package-check/entry/selection';
import type { AnalysisCacheController } from './analysis-cache';
import { PreflightGenerationCache } from './cache';
import type { ConfigObservation } from './config-observation';
import { registerPreflightGenerationAdvancer } from './generation';
import { ensurePreflightGraphMaterialized } from './materialization';
import * as queries from './queries';
import * as setup from './setup';
import type {
  LiminaPreflightManagerOptions,
  MaterializationReceipt,
  PackageEntryPlanOptions,
} from './types';
export class LiminaPreflightManager {
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
  readonly #analysisCache: AnalysisCacheController | undefined;
  readonly #configuration: ConfigObservation | undefined;
  #disposed = false;
  artifactNamespace: LiminaArtifactNamespace;
  readonly config: ResolvedLiminaConfig;
  providers: AnalysisProviderSet;
  run: AnalysisRun;
  constructor(options: LiminaPreflightManagerOptions) {
    this.config = options.config;
    this.#generatedGraphProvider = options.generatedGraphProvider;
    this.#metrics = setup.resolveMetrics(options);
    this.#profilingMetrics = options.metrics;
    this.#signal = setup.resolveSignal(options);
    this.#usesCustomProviders = options.providers !== undefined;
    this.artifactNamespace = setup.resolveArtifactNamespace(options);
    this.#analysisCache = setup.createAnalysisCache(
      options,
      this.artifactNamespace,
    );
    this.#configuration = setup.observeUncachedConfig(
      options,
      this.#analysisCache,
    );
    this.providers = setup.resolveProviders({
      analysisCache: this.#analysisCache?.cache,
      artifactNamespace: this.artifactNamespace,
      managerOptions: options,
    });
    this.run = this.#createRun();
    registerPreflightGenerationAdvancer(this, () =>
      this.#replaceProviderGeneration(true),
    );
  }

  #ensureCheckerRouteSnapshot(): Promise<CheckerRoutes.CheckerRouteSnapshotCollection> {
    this.#cache.checkerRouteSnapshot ??= queries.loadCheckerRouteSnapshot(
      this.config,
      this.ensureGeneratedGraph(),
      () => this.run.metrics,
    );
    return this.#cache.checkerRouteSnapshot;
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
    isAdvance: boolean,
    slot?: PreflightGenerationCache['materializationSlot'],
  ): void {
    this.#assertActive();
    this.#configuration?.assertStable();
    this.#assertDefaultProvidersCanAdvance();
    this.#disposeProviders();
    const analysisCache = this.#refreshAnalysis();
    if (isAdvance) this.#generation += 1;
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
      { analysisCache },
    );
    this.run = this.#createRun();
  }

  #disposeProviders(): void {
    this.providers.dispose?.();
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error('Preflight manager has been disposed.');
  }

  #refreshAnalysis() {
    this.#analysisCache?.refresh();
    return this.#analysisCache?.cache;
  }

  #createRun(): AnalysisRun {
    return setup.createPreflightRun({
      generation: this.#generation,
      providerGeneration: this.#providerGeneration,
      rootDir: this.config.rootDir,
      metrics: this.#metrics,
      signal: this.#signal,
    });
  }

  #retryAnalysis(): void {
    const pending = this.#cache.generatedGraph;
    this.#replaceProviderGeneration(false, this.#cache.materializationSlot);
    this.#cache.generatedGraph = pending;
  }

  get profilingMetrics(): AnalysisMetricsRecorder | undefined {
    return this.#profilingMetrics;
  }

  async publishAnalysisCache(): Promise<void> {
    this.#signal.throwIfAborted();
    this.#configuration?.assertStable();
    await this.#analysisCache?.publish();
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }

    this.#disposed = true;
    this.providers.dispose?.();
  }

  ensureGeneratedGraph(): Promise<GeneratedTsconfigGraphResult> {
    this.#cache.generatedGraph ??= queries.loadAnalyzedGraph({
      cache: this.#analysisCache,
      configObservation: this.#configuration,
      source: this,
      getGraph: this.#generatedGraphProvider,
      refresh: () => this.#retryAnalysis(),
    });
    return this.#cache.generatedGraph;
  }

  ensureWorkspaceValidated(): Promise<ValidatedWorkspace.ValidatedWorkspaceContext> {
    this.#cache.validatedWorkspaceContext ??=
      this.providers.workspace.getValidatedContext();
    return this.#cache.validatedWorkspaceContext;
  }

  ensureGeneratedArtifactsMaterialized(): Promise<MaterializationReceipt> {
    return ensurePreflightGraphMaterialized({
      getCurrentSlot: () => this.#cache.materializationSlot,
      refreshProviders: () =>
        this.#refreshProviderGenerationForMaterialization(),
      slot: this.#cache.materializationSlot,
      source: this,
    });
  }

  ensureWorkspacePackages(): Promise<Workspace.WorkspacePackage[]> {
    this.#cache.workspacePackages ??= queries.loadWorkspacePackages(
      this.ensureWorkspaceValidated(),
    );
    return this.#cache.workspacePackages;
  }

  ensureRawWorkspacePackages(): Promise<Workspace.WorkspacePackage[]> {
    this.#cache.rawWorkspacePackages ??=
      this.providers.workspace.getRawPackages();
    return this.#cache.rawWorkspacePackages;
  }

  ensurePackageOwners(): Promise<Workspace.PackageOwner[]> {
    this.#cache.packageOwners ??= this.providers.workspace.getPackageOwners();
    return this.#cache.packageOwners;
  }

  ensureImporters(): Promise<Workspace.ImporterInfo[]> {
    this.#cache.importers ??= this.providers.workspace.getImporters();
    return this.#cache.importers;
  }

  ensureWorkspaceLookupIndex(): Promise<WorkspaceLookupIndex> {
    this.#cache.workspaceLookup ??= this.providers.workspace.getLookupIndex();
    return this.#cache.workspaceLookup;
  }

  ensureWorkspacePathIndex(): Promise<ValidatedWorkspace.WorkspaceRegionPathIndex> {
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

  async ensureSourceGraphProjectExtensions(): Promise<CheckerRoutes.CollectSourceGraphProjectExtensionsResult> {
    this.#cache.sourceGraphProjectExtensions ??=
      queries.loadSourceGraphProjectExtensions(
        this.config,
        Promise.all([
          this.#ensureCheckerRouteSnapshot(),
          this.ensureGeneratedGraph(),
        ]),
      );
    return this.#cache.sourceGraphProjectExtensions;
  }

  async ensureGraphProjectRoutes(): Promise<CheckerRoutes.CollectCheckerGraphProjectRoutesResult> {
    this.#cache.graphProjectRoutes ??= queries.loadGraphProjectRoutes(
      this.config,
      this.#ensureCheckerRouteSnapshot(),
    );
    return this.#cache.graphProjectRoutes;
  }

  async ensureCheckerEntryProjectRoutes(): Promise<CheckerRoutes.CollectCheckerGraphProjectRoutesResult> {
    this.#cache.checkerEntryProjectRoutes ??=
      queries.loadCheckerEntryProjectRoutes(
        this.config,
        this.#ensureCheckerRouteSnapshot(),
      );
    return this.#cache.checkerEntryProjectRoutes;
  }

  ensureExpectedSourceFiles(): Promise<Set<string>> {
    this.#cache.expectedSourceFiles ??= queries.loadExpectedSourceFiles(
      this.config,
      Promise.all([
        this.ensureGeneratedGraph(),
        this.ensureWorkspaceValidated(),
      ]),
    );
    return this.#cache.expectedSourceFiles;
  }

  async ensurePackageEntrySelectionPlan(
    options: PackageEntryPlanOptions,
  ): Promise<PackageEntrySelectionPlan> {
    return queries.loadPackageEntrySelectionPlan(this, options);
  }

  get importAnalysis(): ImportAnalysisContext {
    return this.providers.imports.context;
  }
}
