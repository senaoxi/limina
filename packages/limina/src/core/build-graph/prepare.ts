import type { ResolvedLiminaInputs } from '#config/runner';
import { compareCodeUnits } from '#utils/collections';
import { withSourceConfigTextScope } from '#utils/source-config-text';
import { currentProfile } from '../../application/analysis/observability';
import { AnalysisInputDriftError } from '../analysis-cache/contracts';
import { EpochInputs } from '../analysis-cache/epoch-inputs';
import { retainGraphExecutionInputs } from '../analysis-cache/execution-inputs';
import {
  createProjectDependencyCaches,
  withProjectDependencyReplay,
} from '../project-dependencies/runner';
import {
  type ValidatedWorkspaceContext,
  WorkspaceRegionPathIndex,
} from '../workspace/validated-context';
import {
  createGraphPreparationError,
  failedGraphAnalysis,
} from './analysis-failure';
import { prepareCheckerOwnership } from './checker-ownership-resolution';
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

function prepareGraph(
  config: ResolvedLiminaInputs,
  options: PrepareGeneratedTsconfigGraphOptions,
  isAnalysisOnly: boolean,
  purpose: PreparedTsconfigGraph['purpose'] = 'complete',
): Promise<PreparedTsconfigGraph | DependencyAnalysisResult> {
  return withSourceConfigTextScope(() =>
    prepareGraphInScope(config, options, isAnalysisOnly, purpose),
  );
}

async function prepareGraphInScope(
  config: ResolvedLiminaInputs,
  options: PrepareGeneratedTsconfigGraphOptions,
  isAnalysisOnly: boolean,
  purpose: PreparedTsconfigGraph['purpose'],
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
  if (options.precomputedCheckerSelection === undefined) {
    beginCoreCollection(projectDependencyCaches);
  }
  let analysis: DependencyAnalysisResult = {
    complete: true,
    facts: [],
    diagnostics: [],
  };
  try {
    // Shared ownership can finish before this graph starts collecting inputs.
    options.precomputedCheckerSelection?.inputs.publish();
    const coloringStart = performance.now();
    const resolveCheckerSelections =
      options.precomputedCheckerSelection === undefined
        ? await prepareCheckerOwnership({
            activatedRegions,
            config,
            importAnalysisContext,
            projectDependencyCaches,
            projectConfigCache: options.projectConfigCache,
            workspaceSourceConfigPaths: workspaceContext.sourceConfigPaths,
          })
        : () => options.precomputedCheckerSelection!;
    const { checkers, state } = withProjectDependencyReplay(
      projectDependencyCaches,
      () => {
        const checkerResolution = resolveCheckerSelections();
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
        if (
          purpose === 'complete' &&
          options.producerBuildReceipt !== undefined
        ) {
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
        return { checkers, state };
      },
    );
    const result = await finishPreparedGraph({
      isAnalysisOnly,
      checkers,
      config,
      state,
      workspaceContext,
      options,
      projectDependencyCaches,
    });
    projectDependencyCaches.analysisCache?.captureLiveContexts();
    return result;
  } catch (error) {
    if (error instanceof AnalysisInputDriftError) throw error;
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
  const analysis = await profile.inWork(work, () =>
    analyzeDependencies(config, options),
  );
  profile.graph(id, {
    purpose: 'dependency-analysis',
    producer: work,
    source: 'computed',
  });
  profile.finish(
    work,
    analysis.complete ? 'computed' : 'failed',
    analysis.complete ? undefined : 'analysis-incomplete',
  );
  return analysis;
}

async function analyzeDependencies(
  config: ResolvedLiminaInputs,
  options: PrepareGeneratedTsconfigGraphOptions,
): Promise<DependencyAnalysisResult> {
  const caches =
    options.projectDependencyCaches ?? createProjectDependencyCaches();
  try {
    return (await prepareGraph(
      config,
      { ...options, projectDependencyCaches: caches },
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
  return observeCorePreparation(async () => {
    const inputs = new EpochInputs();
    const graph = (await inputs.collect(() =>
      prepareGraph(config, options, false),
    )) as GeneratedTsconfigGraphResult;
    retainGraphExecutionInputs(graph, inputs);
    return graph;
  }, options.coreAnalysisWork);
}

export function prepareProducerBuildPlan(
  config: ResolvedLiminaInputs,
  options: PrepareGeneratedTsconfigGraphOptions,
): Promise<ProducerBuildPlan> {
  return observeCorePreparation(async () => {
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
  prepare: () => Promise<T>,
  coreAnalysisWork?: string,
): Promise<T> {
  const profile = currentProfile();
  if (profile === undefined) return prepare();
  const work = profile.start('graph.prepare.core');
  if (coreAnalysisWork !== undefined)
    profile.link('uses-result', work, coreAnalysisWork);
  return profile.inWork(work, async () => {
    try {
      const graph = await prepare();
      recordGraphPreparation(profile, graph, 'core', work);
      profile.finish(work, 'computed');
      return graph;
    } catch (error) {
      profile.fail(work, error, 'graph-preparation-failed');
      throw error;
    }
  });
}
