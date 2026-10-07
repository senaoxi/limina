import type { ResolvedLiminaConfig } from '#config/runner';
import { collectRawWorkspacePackages } from '#core/workspace/actions';
import {
  collectValidatedWorkspaceContext,
  type ValidatedWorkspaceContext,
} from '../workspace/validated-context';

export async function getBuildGraphWorkspace(options: {
  config: ResolvedLiminaConfig;
  workspaceContext?: ValidatedWorkspaceContext;
}): Promise<ValidatedWorkspaceContext> {
  return (
    options.workspaceContext ??
    collectValidatedWorkspaceContext({
      config: options.config,
      rawPackages: await collectRawWorkspacePackages(options.config),
    })
  );
}
