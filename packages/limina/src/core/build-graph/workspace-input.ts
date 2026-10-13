import type { ResolvedLiminaInputs } from '#config/runner';
import { collectRawWorkspacePackages } from '#core/workspace/actions';
import {
  collectValidatedWorkspaceContext,
  type ValidatedWorkspaceContext,
} from '../workspace/validated-context';

export async function getBuildGraphWorkspace(options: {
  config: ResolvedLiminaInputs;
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
