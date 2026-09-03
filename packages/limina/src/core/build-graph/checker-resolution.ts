import type {
  ResolvedCheckerConfig,
  ResolvedLiminaConfig,
} from '#config/runner';
import { collectRawWorkspacePackages } from '#core/workspace/actions';
import type { ProjectDependencyCaches } from '../project-dependencies/contracts';
import { SvelteSemanticContextManager } from '../svelte-semantic/context';
import { VueSemanticContextManager } from '../vue-semantic/context';
import {
  collectValidatedWorkspaceContext,
  WorkspaceRegionPathIndex,
} from '../workspace/validated-context';
import { resolveCheckerOwnership } from './checker-ownership-resolution';
import { resolveBuildGraphImportAnalysis } from './import-analysis-context';
import type {
  CheckerSelectionResolution,
  PrepareGeneratedTsconfigGraphOptions,
} from './types';

export async function resolveGeneratedGraphCheckerSelections(options: {
  config: ResolvedLiminaConfig;
  importAnalysisContext?: PrepareGeneratedTsconfigGraphOptions['importAnalysisContext'];
  projectDependencyCaches?: ProjectDependencyCaches;
  projectConfigCache?: PrepareGeneratedTsconfigGraphOptions['projectConfigCache'];
  workspaceContext: NonNullable<
    PrepareGeneratedTsconfigGraphOptions['workspaceContext']
  >;
  workspacePathIndex?: WorkspaceRegionPathIndex;
}): Promise<CheckerSelectionResolution> {
  const activatedRegions =
    options.workspacePathIndex ??
    new WorkspaceRegionPathIndex(options.workspaceContext);
  return resolveCheckerOwnership({
    activatedRegions,
    config: options.config,
    importAnalysisContext: resolveBuildGraphImportAnalysis(options),
    projectDependencyCaches: options.projectDependencyCaches,
    projectConfigCache: options.projectConfigCache,
    workspaceSourceConfigPaths: options.workspaceContext.sourceConfigPaths,
  });
}

export async function resolveGeneratedGraphCheckers(
  config: ResolvedLiminaConfig,
  options: Pick<
    PrepareGeneratedTsconfigGraphOptions,
    | 'importAnalysisContext'
    | 'projectConfigCache'
    | 'workspaceContext'
    | 'workspacePathIndex'
  > = {},
): Promise<ResolvedCheckerConfig[]> {
  const workspaceContext = await resolveCheckerWorkspaceContext({
    config,
    workspaceContext: options.workspaceContext,
  });
  const ownedImportAnalysis = createOwnedImportAnalysis({
    config,
    importAnalysisContext: options.importAnalysisContext,
  });
  try {
    const resolution = await resolveGeneratedGraphCheckerSelections({
      config,
      importAnalysisContext: ownedImportAnalysis.context,
      projectConfigCache: options.projectConfigCache,
      workspaceContext,
      workspacePathIndex: options.workspacePathIndex,
    });
    return resolution.selections.map(({ checker }) => checker);
  } finally {
    disposeOwnedImportAnalysis(ownedImportAnalysis);
  }
}

async function resolveCheckerWorkspaceContext(options: {
  config: ResolvedLiminaConfig;
  workspaceContext: PrepareGeneratedTsconfigGraphOptions['workspaceContext'];
}): Promise<
  NonNullable<PrepareGeneratedTsconfigGraphOptions['workspaceContext']>
> {
  if (options.workspaceContext !== undefined) {
    return options.workspaceContext;
  }
  return collectValidatedWorkspaceContext({
    config: options.config,
    rawPackages: await collectRawWorkspacePackages(options.config),
  });
}

function createOwnedImportAnalysis(options: {
  config: ResolvedLiminaConfig;
  importAnalysisContext: PrepareGeneratedTsconfigGraphOptions['importAnalysisContext'];
}): {
  context: NonNullable<
    PrepareGeneratedTsconfigGraphOptions['importAnalysisContext']
  >;
  dispose?: () => void;
} {
  if (options.importAnalysisContext !== undefined) {
    return {
      context: options.importAnalysisContext,
    };
  }

  const vueSemanticContexts = new VueSemanticContextManager();
  const svelteSemanticContexts = new SvelteSemanticContextManager();
  return {
    context: resolveBuildGraphImportAnalysis({
      config: options.config,
      svelteSemanticContexts,
      vueSemanticContexts,
    }),
    dispose: () => {
      svelteSemanticContexts.dispose();
      vueSemanticContexts.dispose();
    },
  };
}

function disposeOwnedImportAnalysis(options: { dispose?: () => void }): void {
  if (options.dispose) {
    options.dispose();
  }
}
