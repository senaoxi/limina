import type { ResolvedLiminaConfig } from '#config/runner';
import type { RunProofCheckOptions } from '../proof/runner';
import {
  createProofCommandContext,
  executeProofCommand,
} from './proof-command';
import { handleProofCommandError } from './proof-command-error';

export type { RunProofCheckOptions } from '../proof/runner';

export async function runProofCheck(
  config: ResolvedLiminaConfig,
  options: RunProofCheckOptions = {},
): Promise<boolean> {
  const context = createProofCommandContext(config, options);

  try {
    return await executeProofCommand(context);
  } catch (error) {
    return handleProofCommandError(context, error);
  }
}
