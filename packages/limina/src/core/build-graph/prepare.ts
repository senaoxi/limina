import type { ResolvedLiminaInputs } from '#config/runner';
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
import type {
  DependencyAnalysisResult,
  GeneratedTsconfigGraphResult,
  PrepareGeneratedTsconfigGraphOptions,
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
): Promise<GeneratedTsconfigGraphResult | DependencyAnalysisResult> {
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
    );
    analysis = state.dependencyAnalysis;
    prepareAndRegisterCheckers(
      {
        activatedRegions,
        config,
        ownershipPlan: checkerResolution.ownershipPlan,
        projectConfigCache: options.projectConfigCache,
        selections: checkerSelections,
      },
      state,
    );
    completePreparedGraph(isAnalysisOnly, {
      activatedRegions,
      checkers,
      config,
      importAnalysisContext,
      projectDependencyCaches,
      projectConfigCache: options.projectConfigCache,
      state,
    });
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
  if (cache === undefined) return undefined;
  return restoreGeneratedGraph({
    cache,
    config,
    workspace: options.workspaceContext!,
    preparation: options,
  });
}
export async function prepareGeneratedTsconfigGraph(
  config: ResolvedLiminaInputs,
  options: PrepareGeneratedTsconfigGraphOptions,
): Promise<GeneratedTsconfigGraphResult> {
  const workspaceContext = await getBuildGraphWorkspace({
    config,
    workspaceContext: options.workspaceContext,
  });
  const current = { ...options, workspaceContext };
  return (
    (await restorePreparedGraph(config, current)) ??
    ((await prepareGraph(
      config,
      current,
      false,
    )) as GeneratedTsconfigGraphResult)
  );
}

export async function analyzeProjectDependencies(
  config: ResolvedLiminaInputs,
  options: PrepareGeneratedTsconfigGraphOptions,
): Promise<DependencyAnalysisResult> {
  const caches =
    options.projectDependencyCaches ?? createProjectDependencyCaches();
  try {
    return await analyzePreparedDependencies(config, {
      ...options,
      projectDependencyCaches: caches,
    });
  } catch (error) {
    return failedGraphAnalysis(
      error,
      { complete: false, facts: [], diagnostics: [] },
      caches,
    );
  }
}

async function analyzePreparedDependencies(
  config: ResolvedLiminaInputs,
  options: PrepareGeneratedTsconfigGraphOptions,
): Promise<DependencyAnalysisResult> {
  return (
    (await restoreCachedDependencyAnalysis(config, options)) ??
    ((await prepareGraph(config, options, true)) as DependencyAnalysisResult)
  );
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
