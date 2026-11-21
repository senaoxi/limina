import type { CheckerProjectConfigCache } from '#checkers';
import type { ResolvedLiminaInputs } from '#config/runner';
import {
  type GeneratedDependencyEdge,
  type GeneratedTsconfigGraphResult,
  prepareGeneratedTsconfigGraph,
  prepareProducerBuildPlan,
  type ProducerBuildPlan,
} from '#core/build-graph/runner';
import { currentProfile } from '../application/analysis/observability';
import type { LiminaArtifactNamespace } from '../domain/artifacts/namespace';
import { resolveGeneratedGraphCheckerSelections } from './build-graph/checker-resolution';
import {
  beginCoreCollection,
  type FrameworkInferenceAmbiguity,
  readFrameworkInferenceAmbiguities,
} from './build-graph/core-collection-run';
import { observeGraphRequest } from './build-graph/graph-profile';
import type { ProducerBuildReceipt } from './build-graph/producer-receipt';
import { canExcludeSvelteProjects } from './build-graph/svelte-route-precheck';
import type { ImportCore } from './imports';
import type { ProjectDependencyCaches } from './project-dependencies/contracts';
import { createProjectDependencyCaches } from './project-dependencies/runner';
import { mapPromise } from './promise';
import type { WorkspaceCore } from './workspace';

export class BuildGraphCore {
  readonly #config: ResolvedLiminaInputs;

  readonly #imports: ImportCore;

  readonly #projectConfigs: CheckerProjectConfigCache;

  readonly #projectDependencies: ProjectDependencyCaches;

  readonly #workspace: WorkspaceCore;

  readonly #artifactNamespace: LiminaArtifactNamespace;

  readonly #onGraphPrepared: (graph: GeneratedTsconfigGraphResult) => void;

  #graphPromise: Promise<GeneratedTsconfigGraphResult> | undefined;
  #producerPromise: Promise<ProducerBuildPlan> | undefined;
  #svelteProjects: Promise<boolean> | undefined;
  #svelteExclusion: Promise<boolean> | undefined;
  #producerReceipt: ProducerBuildReceipt | undefined;
  #frameworkInferenceAmbiguities:
    | readonly FrameworkInferenceAmbiguity[]
    | undefined;

  constructor(options: {
    artifactNamespace: LiminaArtifactNamespace;
    config: ResolvedLiminaInputs;
    imports: ImportCore;
    projectDependencies: ProjectDependencyCaches;
    projectConfigs: CheckerProjectConfigCache;
    workspace: WorkspaceCore;
    onGraphPrepared(graph: GeneratedTsconfigGraphResult): void;
  }) {
    this.#artifactNamespace = options.artifactNamespace;
    this.#config = options.config;
    this.#imports = options.imports;
    this.#projectConfigs = options.projectConfigs;
    this.#projectDependencies = options.projectDependencies;
    this.#workspace = options.workspace;
    this.#onGraphPrepared = options.onGraphPrepared;
  }

  #prepareGraph(): Promise<GeneratedTsconfigGraphResult> {
    const workspacePromise = Promise.all([
      this.#workspace.getValidatedContext(),
      this.#workspace.getPathIndex(),
    ]);
    const graphPromise = mapPromise(
      workspacePromise,
      ([workspaceContext, workspacePathIndex]) =>
        prepareGeneratedTsconfigGraph(this.#config, {
          producerBuildReceipt: this.#producerReceipt,
          artifactNamespace: this.#artifactNamespace,
          importAnalysisContext: this.#imports.context,
          projectDependencyCaches: this.#projectDependencies,
          projectConfigCache: this.#projectConfigs,
          workspaceContext,
          workspacePathIndex,
        }),
    );
    return (async () => {
      try {
        const graph = await graphPromise;
        this.#onGraphPrepared(graph);
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
    const ambiguities = readFrameworkInferenceAmbiguities(caches);
    if (ambiguities !== undefined)
      this.#frameworkInferenceAmbiguities = ambiguities;
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
    this.#svelteExclusion ??= (async () => {
      const [workspaceContext, workspacePathIndex] = await Promise.all([
        this.#workspace.getValidatedContext(),
        this.#workspace.getPathIndex(),
      ]);
      return canExcludeSvelteProjects({
        config: this.#config,
        activatedRegions: workspacePathIndex,
        generation: this.#artifactNamespace.generation,
        workspaceSourceConfigPaths: workspaceContext.sourceConfigPaths,
      });
    })();
    return this.#svelteExclusion;
  }

  hasSvelteCheckProjects(): Promise<boolean> {
    this.#svelteProjects ??= (async () => {
      const [workspaceContext, workspacePathIndex] = await Promise.all([
        this.#workspace.getValidatedContext(),
        this.#workspace.getPathIndex(),
      ]);
      beginCoreCollection(this.#projectDependencies);
      try {
        const resolution = await resolveGeneratedGraphCheckerSelections({
          config: this.#config,
          workspaceContext,
          workspacePathIndex,
          importAnalysisContext: this.#imports.context,
          projectConfigCache: this.#projectConfigs,
          projectDependencyCaches: this.#projectDependencies,
        });
        return resolution.selections.some(
          ({ checker }) => checker.name === 'svelte-check',
        );
      } finally {
        this.#retainInferenceDiagnostics(this.#projectDependencies);
      }
    })();
    return this.#svelteProjects;
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
    return this.#frameworkInferenceAmbiguities;
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
