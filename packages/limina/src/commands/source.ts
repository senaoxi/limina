import type { ResolvedLiminaConfig } from '#config/runner';
import type { RunSourceCheckOptions } from '../source-check/runner';
import {
  createSourceCommandContext,
  executeSourceCommand,
  handleSourceCommandError,
} from './source-command';

export type { RunSourceCheckOptions } from '../source-check/runner';

export async function runSourceCheck(
  config: ResolvedLiminaConfig,
  options: RunSourceCheckOptions = {},
): Promise<boolean> {
  const context = await createSourceCommandContext(config, options);

  try {
    return await executeSourceCommand(context);
  } catch (error) {
    return handleSourceCommandError(context, error);
  }
}
