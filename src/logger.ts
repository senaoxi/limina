import { createLogger } from 'logaria';

import type { ScopedLogger } from 'logaria/types';
import readline from 'node:readline';
import { supportsInteractiveTerminal } from './terminal-environment';

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
  return supportsInteractiveTerminal(process.env, process.stdout);
}

function isIntegerCliScreenRows(rows: number | undefined): rows is number {
  return Number.isInteger(rows);
}

function resolveCliScreenRows(rows: number | undefined): number | undefined {
  if (!isIntegerCliScreenRows(rows)) {
    return undefined;
  }

  return rows >= 2 ? rows : undefined;
}

function createScreenPadding(rows: number): string {
  const repeatCount = rows - 2;
  return repeatCount > 0 ? '\n'.repeat(repeatCount) : '';
}

function writeScreenPadding(rows: number): void {
  const padding = createScreenPadding(rows);
  if (padding.length > 0) {
    process.stdout.write(padding);
  }
}

export function clearCliScreen(): void {
  if (!canClearCliScreen()) {
    return;
  }

  const rows = resolveCliScreenRows(process.stdout.rows);
  if (rows === undefined) {
    return;
  }

  writeScreenPadding(rows);
  readline.cursorTo(process.stdout, 0, 1);
  readline.clearScreenDown(process.stdout);
}

export { formatErrorMessage } from 'logaria/helper';
