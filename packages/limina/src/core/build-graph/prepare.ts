import type { ResolvedLiminaInputs } from '#config/runner';
import { compareCodeUnits } from '#utils/collections';
import { currentProfile } from '../../application/analysis/observability';
import { EpochInputs } from '../analysis-cache/epoch-inputs';
import { retainGraphExecutionInputs } from '../analysis-cache/execution-inputs';
import { recordCacheMiss } from '../analysis-cache/profile-decisions';
import { createProjectDependencyCaches } from '../project-dependencies/runner';
import {
  type ValidatedWorkspaceContext,
  WorkspaceRegionPathIndex,
} from '../workspace/validated-context';
import {
  restoreCachedDependencyAnalysis,
  restoreGeneratedGraph,
} from './analysis-cache';
import {
  createGraphPreparationError,
  failedGraphAnalysis,
} from './analysis-failure';
import { resolveGeneratedGraphCheckerSelections } from './checker-resolution';
import { beginCoreCollection } from './core-collection-run';
import { finishPreparedGraph } from './finish-prepared-graph';
import { recordGraphPreparation } from './graph-profile';
import {
  analyzeAndCompleteGeneratedGraph,
  validateAndCompleteGeneratedGraph,
} from './graph-validation';
import { resolveBuildGraphImportAnalysis } from './import-analysis-context';
import {
  createOwnedAstroSemanticContexts,
  createOwnedSvelteSemanticContexts,
  createOwnedVueSemanticContexts,
  disposeOwnedAstroSemanticContexts,
  disposeOwnedSvelteSemanticContexts,
  disposeOwnedVueSemanticContexts,
} from './owned-semantic-contexts';
import { prepareCheckerGraphs } from './prepare-checker-graphs';
import {
  createGeneratedGraphPreparationState,
  registerPreparedChecker,
} from './prepare-state';
import { observeProducerOutputMappings } from './producer-receipt';
import { inferProjectReferences } from './reference-inference';
import {
  createSvelteConsumerView,
  projectSvelteConsumerConfigs,
} from './svelte-consumer-view';
import type {
  DependencyAnalysisResult,
  GeneratedTsconfigGraphResult,
  PreparedTsconfigGraph,
  PrepareGeneratedTsconfigGraphOptions,
  ProducerBuildPlan,
} from './types';
import { getBuildGraphWorkspace } from './workspace-input';

function getWorkspacePathIndex(options: {
  workspaceContext: ValidatedWorkspaceContext;
  workspacePathIndex?: WorkspaceRegionPathIndex;
}): WorkspaceRegionPathIndex {
  return (
    options.workspacePathIndex ??
    new WorkspaceRegionPathIndex(options.workspaceContext)
  );
}

async function prepareGraph(
  config: ResolvedLiminaInputs,
  options: PrepareGeneratedTsconfigGraphOptions,
  isAnalysisOnly: boolean,
  purpose: PreparedTsconfigGraph['purpose'] = 'complete',
): Promise<PreparedTsconfigGraph | DependencyAnalysisResult> {
  const workspaceContext = await getBuildGraphWorkspace({
    config,
    workspaceContext: options.workspaceContext,
  });
  const activatedRegions = getWorkspacePathIndex({
    workspaceContext,
    workspacePathIndex: options.workspacePathIndex,
  });
  const ownedVueSemanticContexts = createOwnedVueSemanticContexts(options);
  const ownedAstroSemanticContexts = createOwnedAstroSemanticContexts(
    options,
    config,
  );
  const ownedSvelteSemanticContexts =
    createOwnedSvelteSemanticContexts(options);
  const importAnalysisContext = resolveBuildGraphImportAnalysis({
    astroSemanticContexts: ownedAstroSemanticContexts,
    config,
    importAnalysisContext: options.importAnalysisContext,
    svelteSemanticContexts: ownedSvelteSemanticContexts,
    vueSemanticContexts: ownedVueSemanticContexts,
  });
  const projectDependencyCaches = dependencyCaches(options);
  beginCoreCollection(projectDependencyCaches);
  let analysis: DependencyAnalysisResult = {
    complete: true,
    facts: [],
    diagnostics: [],
  };
  try {
    const coloringStart = performance.now();
    const checkerResolution = await resolveGeneratedGraphCheckerSelections({
      config,
      importAnalysisContext,
      projectDependencyCaches,
      projectConfigCache: options.projectConfigCache,
      workspaceContext,
      workspacePathIndex: activatedRegions,
    });
    recordElapsed(projectDependencyCaches, 'coloringMs', coloringStart);
    const checkerSelections = checkerResolution.selections;
    const checkers = checkerSelections.map(({ checker }) => checker);
    const state = createGeneratedGraphPreparationState(
      config.rootDir,
      checkerResolution.ownershipPlan,
      purpose,
    );
    analysis = state.dependencyAnalysis;
    prepareAndRegisterCheckers(
      {
        activatedRegions,
        config,
        ownershipPlan: checkerResolution.ownershipPlan,
        frozenProjectsByConfigPath:
          checkerResolution.frozenProjectsByConfigPath,
        projectConfigCache: options.projectConfigCache,
        selections: checkerSelections,
      },
      state,
    );
    if (purpose === 'complete' && options.producerBuildReceipt !== undefined) {
      createSvelteConsumerView(
        state,
        options.producerBuildReceipt,
        config.rootDir,
      );
      projectSvelteConsumerConfigs(state, config);
    }
    completePreparedGraph(isAnalysisOnly, {
      activatedRegions,
      checkers,
      config,
      importAnalysisContext,
      projectDependencyCaches,
      projectConfigCache: options.projectConfigCache,
      state,
    });
    if (state.svelteConsumerView !== undefined) {
      const first = state.dependencyEdges.filter(
        (edge) => edge.fromChecker === 'svelte-check',
      );
      projectSvelteConsumerConfigs(state, config);
      const confirmed = inferProjectReferences({
        activatedRegions,
        config,
        importAnalysisContext,
        governedSources:
          state.governedSourcesByChecker.get('svelte-check') ?? [],
        ownerGovernedSources: state.governedSourcesByChecker
          .values()
          .toArray()
          .flat(),
        ownerProjects: state.projectsByChecker.values().toArray().flat(),
        primaryProjects:
          state.primaryProjectsByChecker.get('svelte-check') ?? [],
        projects: state.projectsByChecker.get('svelte-check') ?? [],
        projectDependencyCaches,
        sourceToBuildByChecker: state.sourceToBuildByChecker,
        svelteConsumerView: state.svelteConsumerView,
      });
      const identity = (edges: typeof first) =>
        JSON.stringify(
          [
            ...new Set(
              edges.map((edge) =>
                JSON.stringify([edge.fromConfigPath, edge.toConfigPath]),
              ),
            ),
          ].sort(compareCodeUnits),
        );
      if (
        confirmed.problems.length > 0 ||
        identity(first) !== identity(confirmed.dependencyEdges)
      )
        throw new Error(
          `Final Svelte execution view changes consumer bindings: ${confirmed.problems.join('\n')}\nCandidate: ${JSON.stringify(first)}\nFinal: ${JSON.stringify(confirmed.dependencyEdges)}`,
        );
      state.dependencyEdges = [
        ...state.dependencyEdges.filter(
          (edge) => edge.fromChecker !== 'svelte-check',
        ),
        ...confirmed.dependencyEdges,
      ];
    }
    return await finishPreparedGraph({
      isAnalysisOnly,
      checkers,
      config,
      state,
      workspaceContext,
      options,
      projectDependencyCaches,
    });
  } catch (error) {
    const failed = failedGraphAnalysis(
      error,
      analysis,
      projectDependencyCaches,
    );
    return returnFailedGraph(error, failed, isAnalysisOnly);
  } finally {
    disposeOwnedAstroSemanticContexts(ownedAstroSemanticContexts);
    disposeOwnedSvelteSemanticContexts(ownedSvelteSemanticContexts);
    disposeOwnedVueSemanticContexts(ownedVueSemanticContexts);
  }
}

async function restorePreparedGraph(
  config: ResolvedLiminaInputs,
  options: PrepareGeneratedTsconfigGraphOptions,
): Promise<GeneratedTsconfigGraphResult | undefined> {
  const cache = options.projectDependencyCaches?.analysisCache;
  if (options.producerBuildReceipt !== undefined) {
    recordCacheMiss('analysis-graph', 'managed-execution-view', {
      bypassed: true,
      basis: cache?.snapshotDecision,
    });
    return undefined;
  }
  if (cache === undefined) {
    recordCacheMiss('analysis-graph', 'cache-controller-unavailable', {
      bypassed: true,
    });
    return undefined;
  }
  return restoreGeneratedGraph({
    cache,
    config,
    workspace: options.workspaceContext!,
    preparation: options,
  });
}
async function prepareCurrentGraph(
  config: ResolvedLiminaInputs,
  options: PrepareGeneratedTsconfigGraphOptions,
  restored?: () => void,
): Promise<GeneratedTsconfigGraphResult> {
  const workspaceContext = await getBuildGraphWorkspace({
    config,
    workspaceContext: options.workspaceContext,
  });
  const current = { ...options, workspaceContext };
  const graph = await restorePreparedGraph(config, current);
  if (graph !== undefined) {
    restored?.();
    return graph;
  }
  return (await prepareGraph(
    config,
    current,
    false,
  )) as GeneratedTsconfigGraphResult;
}

export async function analyzeProjectDependencies(
  config: ResolvedLiminaInputs,
  options: PrepareGeneratedTsconfigGraphOptions,
): Promise<DependencyAnalysisResult> {
  const profile = currentProfile();
  if (profile === undefined) return analyzeDependencies(config, options);
  const id = profile.id('dependency-analysis');
  const work = profile.start('graph.prepare.dependency-analysis', [
    'graph',
    id,
  ]);
  let source: 'computed' | 'restored' = 'computed';
  const analysis = await profile.inWork(work, () =>
    analyzeDependencies(config, options, () => {
      source = 'restored';
    }),
  );
  profile.graph(id, { purpose: 'dependency-analysis', producer: work, source });
  profile.finish(
    work,
    analysis.complete ? source : 'failed',
    analysis.complete ? undefined : 'analysis-incomplete',
  );
  return analysis;
}

async function analyzeDependencies(
  config: ResolvedLiminaInputs,
  options: PrepareGeneratedTsconfigGraphOptions,
  restored?: () => void,
): Promise<DependencyAnalysisResult> {
  const caches =
    options.projectDependencyCaches ?? createProjectDependencyCaches();
  try {
    const current = {
      ...options,
      projectDependencyCaches: caches,
    };
    const analysis = await restoreCachedDependencyAnalysis(config, current);
    if (analysis !== undefined) {
      restored?.();
      return analysis;
    }
    return (await prepareGraph(
      config,
      current,
      true,
    )) as DependencyAnalysisResult;
  } catch (error) {
    return failedGraphAnalysis(
      error,
      { complete: false, facts: [], diagnostics: [] },
      caches,
    );
  }
}

function dependencyCaches(options: PrepareGeneratedTsconfigGraphOptions) {
  const caches =
    options.projectDependencyCaches ?? createProjectDependencyCaches();
  caches.analysisCache?.increment('graphBuilds');
  return caches;
}
function registerCheckers(
  checkers: ReturnType<typeof prepareCheckerGraphs>,
  state: ReturnType<typeof createGeneratedGraphPreparationState>,
): void {
  for (const preparedChecker of checkers)
    registerPreparedChecker({ preparedChecker, state });
}
function graphCompletion(isAnalysisOnly: boolean) {
  return isAnalysisOnly
    ? analyzeAndCompleteGeneratedGraph
    : validateAndCompleteGeneratedGraph;
}
function recordElapsed(
  caches: ReturnType<typeof dependencyCaches>,
  key: string,
  start: number,
): void {
  const metrics = caches.analysisCache?.metrics;
  if (metrics !== undefined) addElapsed(metrics, key, start);
}

function addElapsed(
  metrics: Record<string, number>,
  key: string,
  start: number,
): void {
  metrics[key] = (metrics[key] ?? 0) + performance.now() - start;
}

function prepareAndRegisterCheckers(
  options: Parameters<typeof prepareCheckerGraphs>[0],
  state: Parameters<typeof registerCheckers>[1],
): void {
  registerCheckers(prepareCheckerGraphs(options), state);
}

function completePreparedGraph(
  isAnalysisOnly: boolean,
  options: Parameters<typeof validateAndCompleteGeneratedGraph>[0],
): void {
  const start = performance.now();
  graphCompletion(isAnalysisOnly)(options);
  if (options.projectDependencyCaches !== undefined)
    recordElapsed(options.projectDependencyCaches, 'graphValidationMs', start);
}

function returnFailedGraph(
  error: unknown,
  analysis: DependencyAnalysisResult,
  isAnalysisOnly: boolean,
): DependencyAnalysisResult {
  if (isAnalysisOnly) return analysis;
  throw createGraphPreparationError(error, analysis);
}

export function prepareGeneratedTsconfigGraph(
  config: ResolvedLiminaInputs,
  options: PrepareGeneratedTsconfigGraphOptions,
): Promise<GeneratedTsconfigGraphResult> {
  return observeCorePreparation(async (restored) => {
    const inputs = new EpochInputs();
    const graph = await inputs.collect(() =>
      prepareCurrentGraph(config, options, restored),
    );
    retainGraphExecutionInputs(graph, inputs);
    return graph;
  });
}

export function prepareProducerBuildPlan(
  config: ResolvedLiminaInputs,
  options: PrepareGeneratedTsconfigGraphOptions,
): Promise<ProducerBuildPlan> {
  return observeCorePreparation(async () => {
    const cache = options.projectDependencyCaches?.analysisCache;
    recordCacheMiss('analysis-graph', 'producer-build-plan', {
      bypassed: true,
      basis: cache?.snapshotDecision,
    });
    const inputs = new EpochInputs();
    const graph = await inputs.collect(() =>
      prepareGraph(config, options, false, 'producer-build'),
    );
    if (!('purpose' in graph) || graph.purpose !== 'producer-build')
      throw new Error(
        'Producer preparation did not establish a producer build plan.',
      );
    graph.declarationOutputs = await inputs.collect(() =>
      observeProducerOutputMappings(graph, config.rootDir),
    );
    retainGraphExecutionInputs(graph, inputs);
    return graph;
  });
}

function observeCorePreparation<T extends PreparedTsconfigGraph>(
  prepare: (restored?: () => void) => Promise<T>,
): Promise<T> {
  const profile = currentProfile();
  if (profile === undefined) return prepare();
  const work = profile.start('graph.prepare.core');
  let source: 'computed' | 'restored' = 'computed';
  return profile.inWork(work, async () => {
    try {
      const graph = await prepare(() => {
        source = 'restored';
      });
      recordGraphPreparation(profile, graph, 'core', work, source);
      profile.finish(work, source);
      return graph;
    } catch (error) {
      profile.finish(work, 'failed', 'graph-preparation-failed');
      throw error;
    }
  });
}
