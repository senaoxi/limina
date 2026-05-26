import { createLogger } from 'logaria';
import { formatErrorMessage } from 'logaria/helper';
import type { ScopedLogger } from 'logaria/types';
import readline from 'node:readline';

const logger = createLogger({
  main: 'limina',
});

export const CliLogger: ScopedLogger = logger.getLoggerByGroup('task.cli');
export const GraphLogger: ScopedLogger = logger.getLoggerByGroup('task.graph');
export const InitLogger: ScopedLogger = logger.getLoggerByGroup('task.init');
export const PackageLogger: ScopedLogger =
  logger.getLoggerByGroup('task.package');
export const PathsLogger: ScopedLogger = logger.getLoggerByGroup('task.paths');
export const ProofLogger: ScopedLogger = logger.getLoggerByGroup('task.proof');
export const ReleaseLogger: ScopedLogger =
  logger.getLoggerByGroup('task.release');
export const SourceLogger: ScopedLogger =
  logger.getLoggerByGroup('task.source');
export const TypecheckLogger: ScopedLogger =
  logger.getLoggerByGroup('task.typecheck');

export function clearCliScreen(): void {
  if (!process.stdout.isTTY || process.env.CI) {
    return;
  }

  const repeatCount = (process.stdout.rows ?? 0) - 2;
  const blank = repeatCount > 0 ? '\n'.repeat(repeatCount) : '';

  process.stdout.write(blank);
  readline.cursorTo(process.stdout, 0, 0);
  readline.clearScreenDown(process.stdout);
}

export { formatErrorMessage };
