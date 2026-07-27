import { createLogger } from 'logaria';

import type { ScopedLogger } from 'logaria/types';
import readline from 'node:readline';

const logger = createLogger({
  main: 'limina',
});

export const CliLogger: ScopedLogger = logger.getLoggerByGroup('task.cli');
export const GraphLogger: ScopedLogger = logger.getLoggerByGroup('task.graph');
export const InitLogger: ScopedLogger = logger.getLoggerByGroup('task.init');
export const MigrationLogger: ScopedLogger =
  logger.getLoggerByGroup('task.migration');
export const PackageLogger: ScopedLogger =
  logger.getLoggerByGroup('task.package');
export const ProofLogger: ScopedLogger = logger.getLoggerByGroup('task.proof');
export const ReleaseLogger: ScopedLogger =
  logger.getLoggerByGroup('task.release');
export const SourceLogger: ScopedLogger =
  logger.getLoggerByGroup('task.source');
export const TypecheckLogger: ScopedLogger =
  logger.getLoggerByGroup('task.typecheck');

function canClearCliScreen(): boolean {
  return Boolean(process.stdout.isTTY) && !process.env.CI;
}

function createScreenPadding(rows: number | undefined): string {
  const repeatCount = (rows ?? 0) - 2;
  return repeatCount > 0 ? '\n'.repeat(repeatCount) : '';
}

export function clearCliScreen(): void {
  if (!canClearCliScreen()) {
    return;
  }

  process.stdout.write(createScreenPadding(process.stdout.rows));
  readline.cursorTo(process.stdout, 0, 0);
  readline.clearScreenDown(process.stdout);
}

export { formatErrorMessage } from 'logaria/helper';
