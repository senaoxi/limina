import type { ResolvedLiminaConfig } from '#config/runner';
import {
  type AnalysisProviderSet,
  type CheckerSelectionResolution,
  type CoreAnalysisPhaseObserver,
  createAnalysisProviders,
  type SubscriptionPlan,
} from '#core';
import type {
  GeneratedTsconfigGraphResult,
  PreparedTsconfigGraph,
  ProducerBuildPlan,
} from '#core/build-graph/runner';
import type { ImportAnalysisContext } from '#core/import-analysis/runner';
import type * as CheckerRoutes from '#core/tsconfig/actions';
import type * as Workspace from '#core/workspace/actions';
import { randomUUID } from 'node:crypto';
import type {
  AnalysisMetricsRecorder,
  AnalysisRun,
} from '../application/analysis/analysis-run';
import {
  type AnalysisObserver,
  currentProfile,
} from '../application/analysis/observability';
import type { EpochInputs } from '../core/analysis-cache/epoch-inputs';
import type { FrameworkInferenceAmbiguity } from '../core/build-graph/core-collection-run';
import {
  graphPreparationWork,
  observeGraphRequest,
  recordGraphPreparation,
} from '../core/build-graph/graph-profile';
import {
  assertProducerBuildReceipt,
  type ProducerBuildReceipt,
} from '../core/build-graph/producer-receipt';
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
import { registerPreflightGenerationAdvancer } from './generation';
import {
  capturePendingMaterializationWait,
  ensurePreflightGraphMaterialized,
  type MaterializationAccessObserver,
  materializeProducerDeclarationMirrors,
  observeMaterializationRequest,
  recordActiveMaterializationReceipt,
} from './materialization';
import { withAnalysisProfileMetrics } from './profile-metrics';
import * as queries from './queries';
import * as setup from './setup';
import type {
  LiminaPreflightManagerOptions,
  MaterializationReceipt,
  PackageEntryPlanOptions,
} from './types';
export class LiminaPreflightManager {
  readonly #instanceId = randomUUID();
  readonly #generatedGraphProvider:
    | (() => Promise<GeneratedTsconfigGraphResult>)
    | undefined;
  readonly #metrics: AnalysisMetricsRecorder;
  readonly #profilingMetrics: AnalysisMetricsRecorder | undefined;
  readonly #signal: AbortSignal;
  readonly #subscriptionPlan: SubscriptionPlan | undefined;
  #cache = new PreflightGenerationCache(0);
  #generation = 0;
  #providerGeneration = 0;
  #providerReason = 'initial';
  #privateExecutionView = false;
  #svelteRouteExcluded = false;
  readonly #usesCustomProviders: boolean;
  #analysisCache: AnalysisCacheController | undefined;
  readonly #configuration: { assertStable(): void };
  readonly #retainedProviders = new Map<AnalysisProviderSet, number>();
  readonly #deferredDisposals = new Set<AnalysisProviderSet>();
  #disposed = false;
  #producerReceipt: ProducerBuildReceipt | undefined;
  #frameworkInferenceAmbiguities:
    | readonly FrameworkInferenceAmbiguity[]
    | undefined;
  #consumerPreparation:
    | { receipt: ProducerBuildReceipt; promise: Promise<void> }
    | undefined;
  artifactNamespace: LiminaArtifactNamespace;
  readonly config: ResolvedLiminaConfig;
  providers: AnalysisProviderSet;
  run: AnalysisRun;
  constructor(rawOptions: LiminaPreflightManagerOptions) {
    const options = withAnalysisProfileMetrics(rawOptions);
    this.config = options.config;
    this.#generatedGraphProvider = options.generatedGraphProvider;
    this.#metrics = setup.resolveMetrics(options);
    this.#profilingMetrics = options.metrics;
    this.#signal = setup.resolveSignal(options);
    this.#subscriptionPlan = options.subscriptionPlan;
    this.#usesCustomProviders = options.providers !== undefined;
    this.artifactNamespace = setup.resolveArtifactNamespace(options);
    this.#analysisCache = setup.createAnalysisCache(
      options,
      this.artifactNamespace,
    );
    this.#configuration = setup.observeExecutionConfig(
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
      this.#replaceProviderGeneration({ advance: true }),
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
  #refreshProducerDiscovery(): void {
    // A prior read-only full-graph observation may predate artifact replanning.
    // Start the new phase with fresh discovery, without resolving consumers.
    if (
      !this.#usesCustomProviders &&
      this.#cache.materializationSlot.receipt === undefined &&
      this.#cache.producerBuildPlan === undefined &&
      this.#cache.generatedGraph !== undefined &&
      this.#producerReceipt === undefined
    )
      this.#replaceProviderGeneration({
        slot: this.#cache.materializationSlot,
        reason: 'producer-discovery',
      });
  }
  #refreshProviderGenerationForMaterialization(): void {
    this.#replaceProviderGeneration({
      slot: this.#cache.materializationSlot,
      reason: 'materialization-replan',
    });
  }
  #replaceProviderGeneration(
    options: {
      advance?: true;
      slot?: PreflightGenerationCache['materializationSlot'];
      clearDiagnostics?: true;
      refreshReason?: 'producer-handoff';
      reason?: string;
    } = {},
  ): void {
    this.#assertActive();
    this.#configuration.assertStable();
    this.#assertDefaultProvidersCanAdvance();
    if (options.advance || options.clearDiagnostics)
      this.#frameworkInferenceAmbiguities = undefined;
    this.#disposeProviders();
    this.#analysisCache?.refresh(options.refreshReason);
    const analysisCache = this.#analysisCache?.cache;
    if (options.advance) {
      this.#generation += 1;
      this.#producerReceipt = undefined;
      this.#svelteRouteExcluded = false;
    }
    this.#providerGeneration += 1;
    this.#providerReason =
      options.reason ?? options.refreshReason ?? 'generation-advance';
    this.#cache = new PreflightGenerationCache(this.#generation, options.slot);
    this.artifactNamespace = createLiminaArtifactNamespace({
      generation: this.#providerGeneration,
      rootDir: this.config.rootDir,
    });
    this.providers = createAnalysisProviders(
      this.config,
      this.artifactNamespace,
      this.#profilingMetrics,
      { analysisCache, subscriptionPlan: this.#subscriptionPlan },
    );
    if (this.#producerReceipt !== undefined)
      this.providers.buildGraph.useProducerBuildReceipt(this.#producerReceipt);
    this.run = this.#createRun();
  }
  #disposeProviderSet(providerSet: AnalysisProviderSet): void {
    if ((this.#retainedProviders.get(providerSet) ?? 0) > 0) {
      this.#deferredDisposals.add(providerSet);
      return;
    }
    this.#deferredDisposals.delete(providerSet);
    providerSet.dispose?.();
  }
  #disposeProviders(): void {
    this.#disposeProviderSet(this.providers);
  }
  #assertActive(): void {
    if (this.#disposed) throw new Error('Preflight manager has been disposed.');
  }
  #createRun(): AnalysisRun {
    return setup.createPreflightRun({
      generation: this.#generation,
      instanceId: this.#instanceId,
      providerGeneration: this.#providerGeneration,
      rootDir: this.config.rootDir,
      metrics: this.#metrics,
      signal: this.#signal,
    });
  }
  #retryCoreAnalysis(): void {
    const previous = this.#cache;
    this.#replaceProviderGeneration({
      slot: previous.materializationSlot,
      clearDiagnostics: true,
      reason: 'analysis-retry',
    });
    this.#cache.coreAnalysis = previous.coreAnalysis;
  }
  #retryAnalysis(purpose: PreparedTsconfigGraph['purpose']): void {
    const previous = this.#cache;
    this.#replaceProviderGeneration({
      slot: previous.materializationSlot,
      clearDiagnostics: true,
      reason: 'analysis-retry',
    });
    if (purpose === 'complete') {
      this.#cache.generatedGraph = previous.generatedGraph;
    } else {
      this.#cache.producerBuildPlan = previous.producerBuildPlan;
      this.#cache.producerMaterializationSlot =
        previous.producerMaterializationSlot;
    }
  }
  async #prepareConsumerPhase(receipt: ProducerBuildReceipt): Promise<void> {
    const generation = this.run.generation;
    await materializeProducerDeclarationMirrors(
      receipt,
      this.artifactNamespace,
      this.config.rootDir,
    );
    this.assertExecutionConfigurationStable();
    if (generation !== this.run.generation)
      throw new Error('Consumer preparation generation changed.');
    assertProducerBuildReceipt(receipt);
    this.#producerReceipt = receipt;
    this.#replaceProviderGeneration({ refreshReason: 'producer-handoff' });
  }
  #recordSvelteRoute(hasSvelte: boolean): boolean {
    if (!hasSvelte) this.#svelteRouteExcluded = true;
    return hasSvelte;
  }
  async #validateSvelteRoute<T extends PreparedTsconfigGraph>(
    pending: Promise<T>,
    isCurrent: () => boolean,
  ): Promise<T> {
    const graph = await pending;
    const profile = currentProfile();
    const work = profile?.start('graph.prepare.preflight');
    if (
      this.#svelteRouteExcluded &&
      (graph.governedSources.get('svelte-check')?.size ?? 0) > 0
    ) {
      const error = new Error(
        'Svelte route inputs changed; rerun the command.',
      );
      if (work !== undefined)
        profile?.fail(work, error, 'svelte-route-changed');
      throw error;
    }
    if (profile !== undefined && work !== undefined) {
      if (isCurrent()) {
        const producer = graphPreparationWork(profile, graph);
        if (producer !== undefined) profile.link('uses-result', work, producer);
        recordGraphPreparation(profile, graph, 'preflight', work);
        profile.finish(work);
      } else {
        profile.finish(work, 'superseded', 'graph-request-replaced');
      }
    }
    return graph;
  }
  #observeProviderRun(profile: AnalysisObserver): string {
    return profile.provider(
      this.providers.buildGraph,
      this.#generation,
      this.#providerGeneration,
      this.#providerReason,
      this.run,
    );
  }
  #captureInferenceDiagnostics(generation: number): void {
    if (generation !== this.#generation) return;
    const ambiguities =
      this.providers.buildGraph.getFrameworkInferenceAmbiguities?.();
    if (ambiguities !== undefined)
      this.#frameworkInferenceAmbiguities = ambiguities;
  }
  async #observeInferenceDiagnostics<T>(pending: Promise<T>): Promise<T> {
    const generation = this.#generation;
    try {
      return await pending;
    } finally {
      this.#captureInferenceDiagnostics(generation);
    }
  }
  async #refreshAfterManagedOutputs(
    purpose: PreparedTsconfigGraph['purpose'],
  ): Promise<MaterializationReceipt> {
    const generation = this.run.generation;
    this.assertExecutionConfigurationStable();
    this.#assertDefaultProvidersCanAdvance();
    const pending = new LiminaPreflightManager(
      setup.managedRefreshOptions(
        {
          config: this.config,
          metrics: this.#profilingMetrics,
          signal: this.#signal,
          subscriptionPlan: this.#subscriptionPlan,
        },
        this.#providerGeneration + 1,
      ),
    );
    pending.#generation = this.#generation;
    pending.#providerGeneration = this.#providerGeneration + 1;
    pending.#providerReason = 'managed-output-refresh';
    pending.#privateExecutionView = true;
    pending.#svelteRouteExcluded = this.#svelteRouteExcluded;
    pending.run = pending.#createRun();
    if (purpose === 'complete' && this.#producerReceipt !== undefined) {
      pending.#producerReceipt = this.#producerReceipt;
      pending.providers.buildGraph.useProducerBuildReceipt(
        this.#producerReceipt,
      );
    }
    try {
      const receipt =
        await pending.ensureExecutionArtifactsMaterialized(purpose);
      this.assertExecutionConfigurationStable();
      if (generation !== this.run.generation)
        throw new Error(
          'Managed output refresh generation changed before publication.',
        );
      // Publish one execution view only after its graph and artifacts are ready.
      if (pending.#frameworkInferenceAmbiguities !== undefined)
        this.#frameworkInferenceAmbiguities =
          pending.#frameworkInferenceAmbiguities;
      this.#disposeProviders();
      this.#cache = pending.#cache;
      this.providers = pending.providers;
      this.artifactNamespace = pending.artifactNamespace;
      this.#providerGeneration = pending.#providerGeneration;
      this.#providerReason = pending.#providerReason;
      this.run = pending.run;
      // A handoff is recollected independently; the preceding epoch cannot publish it.
      this.#analysisCache = undefined;
      recordActiveMaterializationReceipt(
        receipt,
        this.#cache.materializationSlot,
        this.run,
      );
      return receipt;
    } catch (error) {
      if (
        generation === this.run.generation &&
        pending.#frameworkInferenceAmbiguities !== undefined
      )
        this.#frameworkInferenceAmbiguities =
          pending.#frameworkInferenceAmbiguities;
      pending.dispose();
      throw error;
    }
  }
  get profilingMetrics(): AnalysisMetricsRecorder | undefined {
    return this.#profilingMetrics;
  }
  refreshAfterManagedOutputs(
    purpose: PreparedTsconfigGraph['purpose'] = 'complete',
  ): Promise<MaterializationReceipt> {
    const refresh = () => this.#refreshAfterManagedOutputs(purpose);
    return (
      observeMaterializationRequest(
        purpose,
        purpose === 'complete' ? 'receipt' : 'applied',
        refresh,
      )?.promise ?? refresh()
    );
  }

  assertExecutionConfigurationStable(): void {
    this.#assertActive();
    this.#signal.throwIfAborted();
    this.#configuration.assertStable();
  }
  recordManagedOutput(
    token: string,
    path: string,
    observation: EpochInputs,
  ): void {
    if (token === this.run.snapshotToken)
      this.#analysisCache?.recordManagedOutput(path, observation);
  }
  async publishAnalysisCache(): Promise<void> {
    this.#signal.throwIfAborted();
    this.#configuration.assertStable();
    if (!this.#usesCustomProviders && this.#analysisCache !== undefined)
      this.providers.releaseDependencyMemos();
    await this.#analysisCache?.publish();
  }
  retainActiveProviders(): () => void {
    const providerSet = this.providers;
    this.#retainedProviders.set(
      providerSet,
      (this.#retainedProviders.get(providerSet) ?? 0) + 1,
    );
    let isReleased = false;
    return () => {
      if (isReleased) return;
      isReleased = true;
      const remaining = (this.#retainedProviders.get(providerSet) ?? 1) - 1;
      if (remaining > 0) {
        this.#retainedProviders.set(providerSet, remaining);
        return;
      }
      this.#retainedProviders.delete(providerSet);
      if (!this.#deferredDisposals.has(providerSet)) return;
      this.#deferredDisposals.delete(providerSet);
      providerSet.dispose?.();
    };
  }
  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    for (const providerSet of this.#deferredDisposals) {
      providerSet.dispose?.();
    }
    this.#deferredDisposals.clear();
    this.#retainedProviders.clear();
    this.providers.dispose?.();
  }
  ensureGeneratedGraph(
    willObserveJoin?: true,
  ): Promise<GeneratedTsconfigGraphResult> {
    const request: Promise<GeneratedTsconfigGraphResult> = observeGraphRequest(
      'complete',
      this.#cache.generatedGraph,
      () =>
        this.#observeInferenceDiagnostics(
          this.#validateSvelteRoute(
            queries.loadAnalyzedGraph({
              cache: this.#analysisCache,
              configObservation: this.#configuration,
              source: this,
              getGraph: () =>
                this.#generatedGraphProvider?.() ??
                this.providers.buildGraph.getGraph(),
              providerRun: (profile) => this.#observeProviderRun(profile),
              refresh: () => this.#retryAnalysis('complete'),
            }),
            () => this.#cache.generatedGraph === request,
          ),
        ),
      'preflight',
      willObserveJoin,
    );
    this.#cache.generatedGraph ??= request;
    return request;
  }
  getMaterializedGraph(): GeneratedTsconfigGraphResult | undefined {
    const graph = this.#cache.materializationSlot.receipt?.graph;
    return graph?.purpose === 'complete' ? graph : undefined;
  }
  getMaterializedProducerGraph(): ProducerBuildPlan | undefined {
    const graph = this.#cache.producerMaterializationSlot.receipt?.graph;
    return graph?.purpose === 'producer-build' ? graph : undefined;
  }
  requiresPostBuildGraphFinalization(): boolean {
    const graph = this.getMaterializedGraph();
    return (
      graph === undefined ||
      (graph.governedSources.get('svelte-check')?.size ?? 0) > 0
    );
  }
  getFrameworkInferenceAmbiguities(): readonly FrameworkInferenceAmbiguity[] {
    return this.#frameworkInferenceAmbiguities ?? [];
  }
  async hasSvelteCheckProjects(): Promise<boolean> {
    const materialized = this.getMaterializedGraph();
    if (materialized !== undefined)
      return this.#recordSvelteRoute(
        (materialized.governedSources.get('svelte-check')?.size ?? 0) > 0,
      );
    this.#refreshProducerDiscovery();
    await this.ensureWorkspaceValidated();
    const generation = this.#generation;
    try {
      return this.#recordSvelteRoute(
        !(await this.providers.buildGraph.canExcludeSvelteCheckProjects()) &&
          (await this.providers.buildGraph.hasSvelteCheckProjects()),
      );
    } finally {
      this.#captureInferenceDiagnostics(generation);
    }
  }
  ensureProducerBuildPlan(willObserveJoin?: true): Promise<ProducerBuildPlan> {
    this.#refreshProducerDiscovery();
    const request: Promise<ProducerBuildPlan> = observeGraphRequest(
      'producer-build',
      this.#cache.producerBuildPlan,
      () =>
        this.#observeInferenceDiagnostics(
          this.#validateSvelteRoute(
            queries.loadAnalyzedGraph({
              cache: this.#analysisCache,
              configObservation: this.#configuration,
              source: this,
              getGraph: () => this.providers.buildGraph.getProducerBuildPlan(),
              providerRun: (profile) => this.#observeProviderRun(profile),
              refresh: () => this.#retryAnalysis('producer-build'),
            }),
            () => this.#cache.producerBuildPlan === request,
          ),
        ),
      'preflight',
      willObserveJoin,
    );
    this.#cache.producerBuildPlan ??= request;
    return request;
  }
  async prepareConsumerPhase(receipt: ProducerBuildReceipt): Promise<void> {
    assertProducerBuildReceipt(receipt);
    if (this.#producerReceipt === receipt) return;
    if (this.#consumerPreparation !== undefined) {
      if (this.#consumerPreparation.receipt !== receipt)
        throw new Error(
          'A different producer receipt is already preparing consumers.',
        );
      await this.#consumerPreparation.promise;
      return;
    }
    const pending = { receipt, promise: this.#prepareConsumerPhase(receipt) };
    this.#consumerPreparation = pending;
    try {
      await pending.promise;
    } finally {
      if (this.#consumerPreparation === pending)
        this.#consumerPreparation = undefined;
    }
  }
  hasProducerReceipt(): boolean {
    return this.#producerReceipt !== undefined;
  }
  assertProducerReceiptCurrent(): void {
    if (this.#producerReceipt !== undefined)
      assertProducerBuildReceipt(this.#producerReceipt);
  }
  ensureExecutionGraph(
    purpose: PreparedTsconfigGraph['purpose'],
  ): Promise<PreparedTsconfigGraph> {
    return purpose === 'producer-build'
      ? this.ensureProducerBuildPlan()
      : this.ensureGeneratedGraph();
  }
  ensureExecutionArtifactsMaterialized(
    purpose: PreparedTsconfigGraph['purpose'],
    onAccess?: MaterializationAccessObserver,
  ): Promise<MaterializationReceipt> {
    if (purpose === 'complete')
      return this.ensureGeneratedArtifactsMaterialized(onAccess);
    const currentNamespace = () => this.artifactNamespace;
    const currentRun = () => this.run;
    const slot = this.#cache.producerMaterializationSlot;
    return ensurePreflightGraphMaterialized({
      getCurrentSlot: () => this.#cache.producerMaterializationSlot,
      getPendingGraph: () => this.#cache.producerBuildPlan,
      onAccess,
      refreshProviders: () => {
        this.#replaceProviderGeneration({ reason: 'materialization-replan' });
        this.#cache.producerMaterializationSlot = slot;
      },
      purpose,
      slot,
      source: {
        get artifactNamespace() {
          return currentNamespace();
        },
        get run() {
          return currentRun();
        },
        ensureGeneratedGraph: (willObserveJoin) =>
          this.ensureProducerBuildPlan(willObserveJoin),
      },
    });
  }
  ensureWorkspaceValidated(): Promise<ValidatedWorkspace.ValidatedWorkspaceContext> {
    this.#cache.validatedWorkspaceContext ??=
      this.providers.workspace.getValidatedContext();
    return this.#cache.validatedWorkspaceContext;
  }
  async ensureGeneratedArtifactsMaterialized(
    onAccess?: MaterializationAccessObserver,
  ): Promise<MaterializationReceipt<GeneratedTsconfigGraphResult>> {
    const slot = this.#cache.materializationSlot;
    const pending = ensurePreflightGraphMaterialized({
      getCurrentSlot: () => this.#cache.materializationSlot,
      getActiveView: () => (this.#privateExecutionView ? undefined : this.run),
      getPendingGraph: () => this.#cache.generatedGraph,
      onAccess,
      willObserveJoin: true,
      purpose: 'complete',
      refreshProviders: () =>
        this.#refreshProviderGenerationForMaterialization(),
      slot,
      source: this,
    });
    const finishWait = capturePendingMaterializationWait(slot, pending);
    let receipt: MaterializationReceipt;
    try {
      receipt = await pending;
      finishWait?.('shared');
    } catch (error) {
      finishWait?.('failed');
      throw error;
    }
    if (receipt.graph.purpose !== 'complete')
      throw new Error(
        'Final graph materialization requires complete admission.',
      );
    return receipt as MaterializationReceipt<GeneratedTsconfigGraphResult>;
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
  ensureCoreAnalysisPrepared(options?: {
    onPhase?: CoreAnalysisPhaseObserver;
  }): Promise<CheckerSelectionResolution> {
    if (this.#cache.coreAnalysis !== undefined) {
      return this.#cache.coreAnalysis;
    }
    const generation = this.#generation;
    const analyze = async () => {
      await this.ensureWorkspaceValidated();
      const profile = currentProfile();
      if (profile === undefined) {
        return this.providers.ownership.getOwnershipProjection(options);
      }
      const providerRun = this.#observeProviderRun(profile);
      return profile.withProviderRun(providerRun, () =>
        this.providers.ownership.getOwnershipProjection(options),
      );
    };
    const pending = this.#observeInferenceDiagnostics(
      this.#analysisCache === undefined
        ? (async () => {
            this.assertExecutionConfigurationStable();
            const resolution = await analyze();
            this.assertExecutionConfigurationStable();
            return resolution;
          })()
        : this.#analysisCache.analyze({
            analyze,
            refresh: () => this.#retryCoreAnalysis(),
          }),
    );
    const run = async (): Promise<CheckerSelectionResolution> => {
      try {
        return await pending;
      } catch (error) {
        if (
          this.#cache.coreAnalysis === wrapped &&
          generation === this.#generation
        ) {
          this.#cache.coreAnalysis = undefined;
        }
        throw error;
      }
    };
    const wrapped = run();
    this.#cache.coreAnalysis = wrapped;
    return wrapped;
  }
  ensureOwnershipProjection(): ReturnType<
    AnalysisProviderSet['ownership']['getOwnershipProjection']
  > {
    return this.providers.ownership.getOwnershipProjection();
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
      this.ensureWorkspaceValidated(),
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
