import type {
  ResolvedCheckerConfig,
  ResolvedLiminaInputs,
} from '#config/runner';
import { collectRawWorkspacePackages } from '#core/workspace/actions';
import { SvelteSemanticContextManager } from '../svelte-semantic/context';
import { VueSemanticContextManager } from '../vue-semantic/context';
import {
  collectValidatedWorkspaceContext,
  WorkspaceRegionPathIndex,
} from '../workspace/validated-context';
import { prepareCheckerOwnership } from './checker-ownership-resolution';
import { resolveBuildGraphImportAnalysis } from './import-analysis-context';
import type { PrepareGeneratedTsconfigGraphOptions } from './types';

export async function resolveGeneratedGraphCheckers(
  config: ResolvedLiminaInputs,
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
    const resolveOwnership = await prepareCheckerOwnership({
      activatedRegions:
        options.workspacePathIndex ??
        new WorkspaceRegionPathIndex(workspaceContext),
      config,
      importAnalysisContext: ownedImportAnalysis.context,
      projectConfigCache: options.projectConfigCache,
      workspaceSourceConfigPaths: workspaceContext.sourceConfigPaths,
    });
    return resolveOwnership().selections.map(({ checker }) => checker);
  } finally {
    disposeOwnedImportAnalysis(ownedImportAnalysis);
  }
}

async function resolveCheckerWorkspaceContext(options: {
  config: ResolvedLiminaInputs;
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
  config: ResolvedLiminaInputs;
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
