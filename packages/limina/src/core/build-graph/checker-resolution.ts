import {
  getActiveCheckers,
  isAutoCheckerConfigMode,
  type ResolvedCheckerConfig,
  type ResolvedLiminaConfig,
} from '#config/runner';
import { collectRawWorkspacePackages } from '#core/workspace/actions';
import {
  createCheckerEntrySelectionOptions,
  resolveCheckerEntrySelection,
} from '../checkers/entry-selection';
import {
  collectValidatedWorkspaceContext,
  WorkspaceRegionPathIndex,
} from '../workspace/validated-context';
import { resolveAutoCheckerSelections } from './auto-checker-resolution';
import type {
  PrepareGeneratedTsconfigGraphOptions,
  ResolvedCheckerEntrySelection,
} from './types';

function isAutoCheckerMode(config: ResolvedLiminaConfig): boolean {
  if (!config.config) {
    return true;
  }
  const checkers = config.config.checkers;
  return checkers === undefined || isAutoCheckerConfigMode(checkers);
}

async function resolveExplicitCheckerSelections(options: {
  config: ResolvedLiminaConfig;
  sourceConfigPaths: readonly string[];
}): Promise<ResolvedCheckerEntrySelection[]> {
  return Promise.all(
    getActiveCheckers(options.config).map(async (checker) => ({
      checker,
      selection: await resolveCheckerEntrySelection(
        {
          config: options.config,
          sourceConfigPaths: options.sourceConfigPaths,
        },
        createCheckerEntrySelectionOptions(checker),
      ),
    })),
  );
}

export async function resolveGeneratedGraphCheckerSelections(options: {
  config: ResolvedLiminaConfig;
  importAnalysisContext?: PrepareGeneratedTsconfigGraphOptions['importAnalysisContext'];
  workspaceContext: NonNullable<
    PrepareGeneratedTsconfigGraphOptions['workspaceContext']
  >;
  workspacePathIndex?: WorkspaceRegionPathIndex;
}): Promise<ResolvedCheckerEntrySelection[]> {
  const activatedRegions =
    options.workspacePathIndex ??
    new WorkspaceRegionPathIndex(options.workspaceContext);
  if (isAutoCheckerMode(options.config)) {
    return resolveAutoCheckerSelections({
      activatedRegions,
      config: options.config,
      importAnalysisContext: options.importAnalysisContext,
      workspaceSourceConfigPaths: options.workspaceContext.sourceConfigPaths,
    });
  }
  return resolveExplicitCheckerSelections({
    config: options.config,
    sourceConfigPaths: options.workspaceContext.sourceConfigPaths,
  });
}

export async function resolveGeneratedGraphCheckers(
  config: ResolvedLiminaConfig,
  options: Pick<
    PrepareGeneratedTsconfigGraphOptions,
    'importAnalysisContext' | 'workspaceContext' | 'workspacePathIndex'
  > = {},
): Promise<ResolvedCheckerConfig[]> {
  const workspaceContext =
    options.workspaceContext ??
    (await collectValidatedWorkspaceContext({
      config,
      rawPackages: await collectRawWorkspacePackages(config),
    }));
  const selections = await resolveGeneratedGraphCheckerSelections({
    config,
    importAnalysisContext: options.importAnalysisContext,
    workspaceContext,
    workspacePathIndex: options.workspacePathIndex,
  });
  return selections.map(({ checker }) => checker);
}
