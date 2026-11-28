import type { CheckerProjectConfigCache } from '#checkers';
import type { ResolvedLiminaInputs } from '#config/runner';
import {
  prepareGeneratedTsconfigGraph,
  prepareProducerBuildPlan,
} from '#core/build-graph/runner';
import { withSourceConfigTextScope } from '#utils/source-config-text';
import { currentProfile } from '../application/analysis/observability';
import type { LiminaArtifactNamespace } from '../domain/artifacts/namespace';
import type { FrameworkInferenceAmbiguity } from './build-graph/core-collection-run';
import { observeGraphRequest } from './build-graph/graph-profile';
import type { ProducerBuildReceipt } from './build-graph/producer-receipt';
import { canExcludeSvelteProjects } from './build-graph/svelte-route-precheck';
import type {
  GeneratedDependencyEdge,
  GeneratedTsconfigGraphResult,
  ObservedCheckerSelection,
  ProducerBuildPlan,
} from './build-graph/types';
import { prepareGovernedRuntime } from './facts/governance';
import type { CoreOwnershipProvider } from './facts/ownership';
import type { CoreFactSession } from './facts/session';
import type { ImportCore } from './imports';
import type { ProjectDependencyCaches } from './project-dependencies/contracts';
import { createProjectDependencyCaches } from './project-dependencies/runner';
import { mapPromise } from './promise';
import { createWorkspaceSourceBoundaryFromProjects } from './typescript-semantic';
import type { WorkspaceCore } from './workspace';

export class BuildGraphCore {
  readonly #config: ResolvedLiminaInputs;

  readonly #imports: ImportCore;

  readonly #projectConfigs: CheckerProjectConfigCache;

  readonly #projectDependencies: ProjectDependencyCaches;

  readonly #workspace: WorkspaceCore;

  readonly #artifactNamespace: LiminaArtifactNamespace;

  readonly #facts: CoreFactSession;

  readonly #ownership: CoreOwnershipProvider;

  #graphPromise: Promise<GeneratedTsconfigGraphResult> | undefined;
  #producerPromise: Promise<ProducerBuildPlan> | undefined;
  #svelteExclusion: Promise<boolean> | undefined;
  #producerReceipt: ProducerBuildReceipt | undefined;

  constructor(options: {
    artifactNamespace: LiminaArtifactNamespace;
    config: ResolvedLiminaInputs;
    facts: CoreFactSession;
    imports: ImportCore;
    ownership: CoreOwnershipProvider;
    projectDependencies: ProjectDependencyCaches;
    projectConfigs: CheckerProjectConfigCache;
    workspace: WorkspaceCore;
  }) {
    this.#artifactNamespace = options.artifactNamespace;
    this.#config = options.config;
    this.#facts = options.facts;
    this.#imports = options.imports;
    this.#ownership = options.ownership;
    this.#projectConfigs = options.projectConfigs;
    this.#projectDependencies = options.projectDependencies;
    this.#workspace = options.workspace;
  }

  #prepareGraph(): Promise<GeneratedTsconfigGraphResult> {
    const workspacePromise = Promise.all([
      this.#workspace.getValidatedContext(),
      this.#workspace.getPathIndex(),
      this.getOwnershipProjection(),
    ]);
    const graphPromise = mapPromise(
      workspacePromise,
      ([workspaceContext, workspacePathIndex, precomputedCheckerSelection]) => {
        const profile = currentProfile();
        return prepareGeneratedTsconfigGraph(this.#config, {
          coreAnalysisWork:
            profile === undefined
              ? undefined
              : this.#ownership.getProfileWork(profile),
          precomputedCheckerSelection,
          producerBuildReceipt: this.#producerReceipt,
          artifactNamespace: this.#artifactNamespace,
          importAnalysisContext: this.#imports.context,
          projectDependencyCaches: this.#projectDependencies,
          projectConfigCache: this.#projectConfigs,
          workspaceContext,
          workspacePathIndex,
        });
      },
    );
    return (async () => {
      try {
        const graph = await graphPromise;
        this.#facts.publishWorkspaceSourceBoundary(
          createWorkspaceSourceBoundaryFromProjects(
            graph.governedSources
              .values()
              .flatMap((sources) => sources.values())
              .map((source) => ({
                ...source,
                fileNames: source.ownedFileNames,
              }))
              .toArray(),
            undefined,
            graph.sourceConfigCoverage,
          ),
        );
        if (
          this.#facts.getSubscriptionPlan()?.products.includes('runtime-only')
        ) {
          const ownership = await this.getOwnershipProjection();
          for (const units of graph.governedSources.values()) {
            for (const unit of units.values()) {
              prepareGovernedRuntime({
                facts: this.#facts,
                ownership,
                importAnalysis: this.#imports.context,
                unit,
              });
            }
          }
        }
        return graph;
      } finally {
        this.#retainInferenceDiagnostics(this.#projectDependencies);
      }
    })();
  }

  async #prepareProducers(): Promise<ProducerBuildPlan> {
    const [workspaceContext, workspacePathIndex] = await Promise.all([
      this.#workspace.getValidatedContext(),
      this.#workspace.getPathIndex(),
    ]);
    const dependencies = createProjectDependencyCaches(
      this.#projectDependencies.analysisCache,
    );
    try {
      return await prepareProducerBuildPlan(this.#config, {
        artifactNamespace: this.#artifactNamespace,
        importAnalysisContext: this.#imports.context,
        projectConfigCache: this.#projectConfigs,
        projectDependencyCaches: dependencies,
        workspaceContext,
        workspacePathIndex,
      });
    } finally {
      this.#retainInferenceDiagnostics(dependencies);
    }
  }

  #retainInferenceDiagnostics(caches: ProjectDependencyCaches): void {
    this.#ownership.retainInferenceDiagnostics(caches);
  }

  #requestCoreGraph<T extends GeneratedTsconfigGraphResult | ProducerBuildPlan>(
    purpose: T['purpose'],
    pending: Promise<T> | undefined,
    prepare: () => Promise<T>,
  ): Promise<T> {
    const profile = currentProfile();
    if (profile === undefined || profile.currentProviderRun() !== undefined)
      return pending ?? prepare();
    return observeGraphRequest(
      purpose,
      pending,
      () => {
        const generation = this.#artifactNamespace.generation;
        const providerRun = profile.provider(
          this,
          generation,
          generation,
          'direct-provider',
        );
        return profile.withProviderRun(providerRun, prepare);
      },
      'core',
    );
  }

  getGraph(): Promise<GeneratedTsconfigGraphResult> {
    const request = this.#requestCoreGraph('complete', this.#graphPromise, () =>
      this.#prepareGraph(),
    );
    return (this.#graphPromise ??= request);
  }

  useProducerBuildReceipt(receipt: ProducerBuildReceipt): void {
    if (this.#graphPromise !== undefined)
      throw new Error(
        'Cannot replace producer receipt after final graph preparation.',
      );
    this.#producerReceipt = receipt;
  }

  canExcludeSvelteCheckProjects(): Promise<boolean> {
    this.#svelteExclusion ??= withSourceConfigTextScope(async () => {
      const [workspaceContext, workspacePathIndex] = await Promise.all([
        this.#workspace.getValidatedContext(),
        this.#workspace.getPathIndex(),
      ]);
      return canExcludeSvelteProjects({
        config: this.#config,
        activatedRegions: workspacePathIndex,
        workspaceSourceConfigPaths: workspaceContext.sourceConfigPaths,
      });
    });
    return this.#svelteExclusion;
  }

  /**
   * Delegates to CoreOwnershipProvider (Stage B1). Kept as a thin facade for
   * backwards compatibility while BuildGraphCore remains a pure Stage B2 consumer.
   */
  getOwnershipProjection(): Promise<ObservedCheckerSelection> {
    return this.#ownership.getOwnershipProjection();
  }

  hasSvelteCheckProjects(): Promise<boolean> {
    return this.#ownership.hasSvelteCheckProjects();
  }

  getProducerBuildPlan(): Promise<ProducerBuildPlan> {
    const request = this.#requestCoreGraph(
      'producer-build',
      this.#producerPromise,
      () => this.#prepareProducers(),
    );
    return (this.#producerPromise ??= request);
  }

  getFrameworkInferenceAmbiguities():
    | readonly FrameworkInferenceAmbiguity[]
    | undefined {
    return this.#ownership.getFrameworkInferenceAmbiguities();
  }

  async getSourceToDts(checkerName: string): Promise<Map<string, string>> {
    const graph = await this.getGraph();

    return new Map(graph.sourceToDts.get(checkerName));
  }

  async getDependencyEdges(): Promise<GeneratedDependencyEdge[]> {
    const graph = await this.getGraph();

    return graph.dependencyEdges.map((edge) => ({ ...edge }));
  }
}
