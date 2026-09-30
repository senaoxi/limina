import type { ResolvedLiminaConfig } from '#config/runner';
import type { RunSourceCheckOptions } from '../source-check/runner';
import {
  createSourceCommandContext,
  isExecuteSourceCommand,
  isHandleSourceCommandError,
} from './source-command';

export type { RunSourceCheckOptions } from '../source-check/runner';

export async function isRunSourceCheck(
  config: ResolvedLiminaConfig,
  options: RunSourceCheckOptions = {},
): Promise<boolean> {
  const context = await createSourceCommandContext(config, options);

  try {
    return await isExecuteSourceCommand(context);
  } catch (error) {
    return isHandleSourceCommandError(context, error);
  }
}
