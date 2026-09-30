import type { ResolvedLiminaConfig } from '#config/runner';
import type { RunProofCheckOptions } from '../proof/runner';
import {
  createProofCommandContext,
  isExecuteProofCommand,
} from './proof-command';
import { handleProofCommandError } from './proof-command-error';

export type { RunProofCheckOptions } from '../proof/runner';

export async function isRunProofCheck(
  config: ResolvedLiminaConfig,
  options: RunProofCheckOptions = {},
): Promise<boolean> {
  const context = createProofCommandContext(config, options);

  try {
    return await isExecuteProofCommand(context);
  } catch (error) {
    return handleProofCommandError(context, error);
  }
}
