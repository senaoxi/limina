import { isSourceKnipEnabled, type ResolvedLiminaConfig } from '#config/runner';
import { LiminaStructuredError } from '../../check-reporting/errors';
import { TypeScriptConfigInputError } from '../../checker/project-base';
import { AstroSemanticContextManager } from '../astro-semantic/context';
import { createProjectDependencyCaches } from '../project-dependencies/runner';
import { SvelteSemanticContextManager } from '../svelte-semantic/context';
import { TsconfigInputError } from '../tsconfig/config-paths';
import { VueSemanticContextManager } from '../vue-semantic/context';
import {
  type ValidatedWorkspaceContext,
  WorkspaceRegionPathIndex,
} from '../workspace/validated-context';
import {
  captureGeneratedGraph,
  restoreCachedDependencyAnalysis,
  restoreGeneratedGraph,
} from './analysis-cache';
import { resolveGeneratedGraphCheckerSelections } from './checker-resolution';
import { finalizeGeneratedGraph } from './finalize-generated-graph';
import { prepareGeneratedKnipPackageConfigs } from './generated-knip';
import {
  analyzeAndCompleteGeneratedGraph,
  validateAndCompleteGeneratedGraph,
} from './graph-validation';
import { resolveBuildGraphImportAnalysis } from './import-analysis-context';
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
import { writeGeneratedGraphConfigs } from './write-generated-graph';

function getWorkspacePathIndex(options: {
  workspaceContext: ValidatedWorkspaceContext;
  workspacePathIndex?: WorkspaceRegionPathIndex;
}): WorkspaceRegionPathIndex {
  return (
    options.workspacePathIndex ??
    new WorkspaceRegionPathIndex(options.workspaceContext)
  );
}

function createOwnedVueSemanticContexts(
  options: PrepareGeneratedTsconfigGraphOptions,
): VueSemanticContextManager | undefined {
  return options.importAnalysisContext === undefined
    ? new VueSemanticContextManager()
    : undefined;
}

function createOwnedAstroSemanticContexts(
  options: PrepareGeneratedTsconfigGraphOptions,
  config: ResolvedLiminaConfig,
): AstroSemanticContextManager | undefined {
  if (options.importAnalysisContext !== undefined) return undefined;
  return new AstroSemanticContextManager({
    governanceRoot: config.governanceRoot,
  });
}

function createOwnedSvelteSemanticContexts(
  options: PrepareGeneratedTsconfigGraphOptions,
): SvelteSemanticContextManager | undefined {
  return options.importAnalysisContext === undefined
    ? new SvelteSemanticContextManager()
    : undefined;
}

function disposeOwnedVueSemanticContexts(
  contexts: VueSemanticContextManager | undefined,
): void {
  if (contexts === undefined) return;
  contexts.dispose();
}

function disposeOwnedAstroSemanticContexts(
  contexts: AstroSemanticContextManager | undefined,
): void {
  if (contexts === undefined) return;
  contexts.dispose();
}

function disposeOwnedSvelteSemanticContexts(
  contexts: SvelteSemanticContextManager | undefined,
): void {
  if (contexts === undefined) return;
  contexts.dispose();
}

function prepareGeneratedKnip(options: {
  checkers: Parameters<
    typeof prepareGeneratedKnipPackageConfigs
  >[0]['checkers'];
  config: ResolvedLiminaConfig;
  state: ReturnType<typeof createGeneratedGraphPreparationState>;
  workspaceContext: ValidatedWorkspaceContext;
}): ReturnType<typeof prepareGeneratedKnipPackageConfigs> {
  if (!isSourceKnipEnabled(options.config)) {
    return { configs: [], diagnostics: [] };
  }
  return prepareGeneratedKnipPackageConfigs({
    checkers: options.checkers,
    config: options.config,
    configToOutputBuildByChecker: options.state.configToOutputBuildByChecker,
    workspacePackages: options.workspaceContext.packages,
    workspaceContext: options.workspaceContext,
  });
}

async function prepareGraph(
  config: ResolvedLiminaConfig,
  options: PrepareGeneratedTsconfigGraphOptions,
  isAnalysisOnly = false,
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
  try {
    const checkerResolution = await resolveGeneratedGraphCheckerSelections({
      config,
      importAnalysisContext,
      projectDependencyCaches,
      projectConfigCache: options.projectConfigCache,
      workspaceContext,
      workspacePathIndex: activatedRegions,
    });
    const checkerSelections = checkerResolution.selections;
    const checkers = checkerSelections.map(({ checker }) => checker);
    const state = createGeneratedGraphPreparationState(
      config.rootDir,
      checkerResolution.ownershipPlan,
    );
    const preparedCheckers = prepareCheckerGraphs({
      activatedRegions,
      config,
      ownershipPlan: checkerResolution.ownershipPlan,
      projectConfigCache: options.projectConfigCache,
      selections: checkerSelections,
    });
    registerCheckers(preparedCheckers, state);
    const completeGraph = graphCompletion(isAnalysisOnly);
    completeGraph({
      activatedRegions,
      checkers,
      config,
      importAnalysisContext,
      projectDependencyCaches,
      projectConfigCache: options.projectConfigCache,
      state,
    });
    if (isAnalysisOnly) return state.dependencyAnalysis;
    const generatedKnip = prepareGeneratedKnip({
      checkers,
      config,
      state,
      workspaceContext,
    });
    await writeGeneratedGraphConfigs({
      checkers,
      config,
      generatedKnip,
      state,
    });
    const result = await finalizeGeneratedGraph({
      artifactNamespace: options.artifactNamespace,
      checkers,
      config,
      generatedKnip,
      state,
    });
    capturePreparedGraph({
      config,
      options,
      workspaceContext,
      result,
      analysis: state.dependencyAnalysis,
    });
    return result;
  } finally {
    disposeOwnedAstroSemanticContexts(ownedAstroSemanticContexts);
    disposeOwnedSvelteSemanticContexts(ownedSvelteSemanticContexts);
    disposeOwnedVueSemanticContexts(ownedVueSemanticContexts);
  }
}

function capturePreparedGraph(input: {
  config: ResolvedLiminaConfig;
  options: PrepareGeneratedTsconfigGraphOptions;
  workspaceContext: ValidatedWorkspaceContext;
  result: GeneratedTsconfigGraphResult;
  analysis: DependencyAnalysisResult;
}): void {
  const cache = input.options.projectDependencyCaches?.analysisCache;
  if (cache !== undefined)
    captureGeneratedGraph({
      cache,
      config: input.config,
      workspace: input.workspaceContext,
      result: input.result,
      analysis: input.analysis,
    });
}
async function restorePreparedGraph(
  config: ResolvedLiminaConfig,
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
  config: ResolvedLiminaConfig,
  options: PrepareGeneratedTsconfigGraphOptions,
): Promise<GeneratedTsconfigGraphResult> {
  const workspaceContext = await getBuildGraphWorkspace({
    config,
    workspaceContext: options.workspaceContext,
  });
  const current = { ...options, workspaceContext };
  return (
    (await restorePreparedGraph(config, current)) ??
    ((await prepareGraph(config, current)) as GeneratedTsconfigGraphResult)
  );
}

export async function analyzeProjectDependencies(
  config: ResolvedLiminaConfig,
  options: PrepareGeneratedTsconfigGraphOptions,
): Promise<DependencyAnalysisResult> {
  try {
    return await analyzePreparedDependencies(config, options);
  } catch (error) {
    if (!isAnalysisInputError(error)) throw error;
    return { complete: false, facts: [], diagnostics: [error.message] };
  }
}

async function analyzePreparedDependencies(
  config: ResolvedLiminaConfig,
  options: PrepareGeneratedTsconfigGraphOptions,
): Promise<DependencyAnalysisResult> {
  return (
    (await restoreCachedDependencyAnalysis(config, options)) ??
    ((await prepareGraph(config, options, true)) as DependencyAnalysisResult)
  );
}
function dependencyCaches(options: PrepareGeneratedTsconfigGraphOptions) {
  return options.projectDependencyCaches ?? createProjectDependencyCaches();
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
function isAnalysisInputError(error: unknown): error is Error {
  return [
    LiminaStructuredError,
    TypeScriptConfigInputError,
    TsconfigInputError,
  ].some((Type) => error instanceof Type);
}
