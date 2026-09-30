import type { RunPackageCheckOptions } from '../package-check/runner';
import {
  createPackageCommandContext,
  handlePackageCommandError,
  isExecutePackageCommand,
} from './package-command';

export type { RunPackageCheckOptions } from '../package-check/runner';

export async function isRunPackageCheck(
  options: RunPackageCheckOptions,
): Promise<boolean> {
  const context = createPackageCommandContext(options);

  try {
    return await isExecutePackageCommand(context);
  } catch (error) {
    return handlePackageCommandError(context, error);
  }
}
