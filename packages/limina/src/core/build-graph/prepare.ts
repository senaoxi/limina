import { isSourceKnipEnabled, type ResolvedLiminaConfig } from '#config/runner';
import { collectRawWorkspacePackages } from '#core/workspace/actions';
import { LiminaStructuredError } from '../../check-reporting/errors';
import { TypeScriptConfigInputError } from '../../checker/project-base';
import { AstroSemanticContextManager } from '../astro-semantic/context';
import { createProjectDependencyCaches } from '../project-dependencies/runner';
import { SvelteSemanticContextManager } from '../svelte-semantic/context';
import { TsconfigInputError } from '../tsconfig/config-paths';
import { VueSemanticContextManager } from '../vue-semantic/context';
import {
  collectValidatedWorkspaceContext,
  type ValidatedWorkspaceContext,
  WorkspaceRegionPathIndex,
} from '../workspace/validated-context';
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
import { writeGeneratedGraphConfigs } from './write-generated-graph';

async function getWorkspaceContext(options: {
  config: ResolvedLiminaConfig;
  workspaceContext?: ValidatedWorkspaceContext;
}): Promise<ValidatedWorkspaceContext> {
  if (options.workspaceContext) {
    return options.workspaceContext;
  }
  return collectValidatedWorkspaceContext({
    config: options.config,
    rawPackages: await collectRawWorkspacePackages(options.config),
  });
}

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
  if (options.importAnalysisContext !== undefined) return undefined;
  return new VueSemanticContextManager();
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
  if (options.importAnalysisContext !== undefined) return undefined;
  return new SvelteSemanticContextManager();
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
  analysisOnly = false,
): Promise<GeneratedTsconfigGraphResult | DependencyAnalysisResult> {
  const workspaceContext = await getWorkspaceContext({
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
    const completeGraph = graphCompletion(analysisOnly);
    completeGraph({
      activatedRegions,
      checkers,
      config,
      importAnalysisContext,
      projectDependencyCaches,
      projectConfigCache: options.projectConfigCache,
      state,
    });
    if (analysisOnly) return state.dependencyAnalysis;
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
    return finalizeGeneratedGraph({
      artifactNamespace: options.artifactNamespace,
      checkers,
      config,
      generatedKnip,
      state,
    });
  } finally {
    disposeOwnedAstroSemanticContexts(ownedAstroSemanticContexts);
    disposeOwnedSvelteSemanticContexts(ownedSvelteSemanticContexts);
    disposeOwnedVueSemanticContexts(ownedVueSemanticContexts);
  }
}

export async function prepareGeneratedTsconfigGraph(
  config: ResolvedLiminaConfig,
  options: PrepareGeneratedTsconfigGraphOptions,
): Promise<GeneratedTsconfigGraphResult> {
  return (await prepareGraph(config, options)) as GeneratedTsconfigGraphResult;
}

export async function analyzeProjectDependencies(
  config: ResolvedLiminaConfig,
  options: PrepareGeneratedTsconfigGraphOptions,
): Promise<DependencyAnalysisResult> {
  try {
    return (await prepareGraph(
      config,
      options,
      true,
    )) as DependencyAnalysisResult;
  } catch (error) {
    if (!isAnalysisInputError(error)) throw error;
    return { complete: false, facts: [], diagnostics: [error.message] };
  }
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
function graphCompletion(analysisOnly: boolean) {
  return analysisOnly
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
