import { isSourceKnipEnabled, type ResolvedLiminaConfig } from '#config/runner';
import { collectRawWorkspacePackages } from '#core/workspace/actions';
import {
  collectValidatedWorkspaceContext,
  type ValidatedWorkspaceContext,
  WorkspaceRegionPathIndex,
} from '../workspace/validated-context';
import { resolveGeneratedGraphCheckerSelections } from './checker-resolution';
import { finalizeGeneratedGraph } from './finalize-generated-graph';
import { prepareGeneratedKnipPackageConfigs } from './generated-knip';
import { validateAndCompleteGeneratedGraph } from './graph-validation';
import { prepareCheckerGraphs } from './prepare-checkers';
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
  const checkerSelections = await resolveGeneratedGraphCheckerSelections({
    config,
    importAnalysisContext: options.importAnalysisContext,
    projectConfigCache: options.projectConfigCache,
    workspaceContext,
    workspacePathIndex: activatedRegions,
  });
  const checkers = checkerSelections.map(({ checker }) => checker);
  const state = createGeneratedGraphPreparationState(config.rootDir);
  const preparedCheckers = prepareCheckerGraphs({
    activatedRegions,
    config,
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
    importAnalysisContext: options.importAnalysisContext,
    projectConfigCache: options.projectConfigCache,
    state,
  });
  const generatedKnip = isSourceKnipEnabled(config)
    ? prepareGeneratedKnipPackageConfigs({
        checkers,
        config,
        configToOutputBuildByChecker: state.configToOutputBuildByChecker,
        workspacePackages: workspaceContext.packages,
      })
    : { configs: [], diagnostics: [] };
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
}
