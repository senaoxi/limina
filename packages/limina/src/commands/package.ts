import type { RunPackageCheckOptions } from '../package-check/runner';
import {
  createPackageCommandContext,
  executePackageCommand,
  handlePackageCommandError,
} from './package-command';

export type { RunPackageCheckOptions } from '../package-check/runner';

export async function runPackageCheck(
  options: RunPackageCheckOptions,
): Promise<boolean> {
  const context = createPackageCommandContext(options);

  try {
    return await executePackageCommand(context);
  } catch (error) {
    return handlePackageCommandError(context, error);
  }
}
