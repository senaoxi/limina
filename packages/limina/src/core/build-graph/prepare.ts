import { isSourceKnipEnabled, type ResolvedLiminaConfig } from '#config/runner';
import { collectRawWorkspacePackages } from '#core/workspace/actions';
import { AstroSemanticContextManager } from '../astro-semantic/context';
import { SvelteSemanticContextManager } from '../svelte-semantic/context';
import { VueSemanticContextManager } from '../vue-semantic/context';
import {
  collectValidatedWorkspaceContext,
  type ValidatedWorkspaceContext,
  WorkspaceRegionPathIndex,
} from '../workspace/validated-context';
import { resolveGeneratedGraphCheckerSelections } from './checker-resolution';
import { finalizeGeneratedGraph } from './finalize-generated-graph';
import { prepareGeneratedKnipPackageConfigs } from './generated-knip';
import { validateAndCompleteGeneratedGraph } from './graph-validation';
import { resolveBuildGraphImportAnalysis } from './import-analysis-context';
import { prepareCheckerGraphs } from './prepare-checker-graphs';
import {
  createGeneratedGraphPreparationState,
  registerPreparedChecker,
} from './prepare-state';
import type {
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
): AstroSemanticContextManager | undefined {
  if (options.importAnalysisContext !== undefined) return undefined;
  return new AstroSemanticContextManager();
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
  });
}

export async function prepareGeneratedTsconfigGraph(
  config: ResolvedLiminaConfig,
  options: PrepareGeneratedTsconfigGraphOptions,
): Promise<GeneratedTsconfigGraphResult> {
  const workspaceContext = await getWorkspaceContext({
    config,
    workspaceContext: options.workspaceContext,
  });
  const activatedRegions = getWorkspacePathIndex({
    workspaceContext,
    workspacePathIndex: options.workspacePathIndex,
  });
  const ownedVueSemanticContexts = createOwnedVueSemanticContexts(options);
  const ownedAstroSemanticContexts = createOwnedAstroSemanticContexts(options);
  const ownedSvelteSemanticContexts =
    createOwnedSvelteSemanticContexts(options);
  const importAnalysisContext = resolveBuildGraphImportAnalysis({
    astroSemanticContexts: ownedAstroSemanticContexts,
    config,
    importAnalysisContext: options.importAnalysisContext,
    svelteSemanticContexts: ownedSvelteSemanticContexts,
    vueSemanticContexts: ownedVueSemanticContexts,
  });
  try {
    const checkerResolution = await resolveGeneratedGraphCheckerSelections({
      config,
      importAnalysisContext,
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
    for (const preparedChecker of preparedCheckers) {
      registerPreparedChecker({ preparedChecker, state });
    }
    validateAndCompleteGeneratedGraph({
      activatedRegions,
      checkers,
      config,
      importAnalysisContext,
      projectConfigCache: options.projectConfigCache,
      state,
    });
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
