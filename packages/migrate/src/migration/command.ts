import type { ResolvedLiminaConfig } from 'limina/internal/config/runner';
import { formatErrorMessage, MigrationLogger } from 'limina/internal/logger';
import { resolvePreflight } from 'limina/internal/preflight';
import { createElapsedTimer } from 'logaria/helper';
import type { MigrationCleanupWarning } from './transaction';
import type {
  RunMigrationImplResult,
  RunMigrationOptions,
  RunMigrationResult,
} from './types';

import { runMigrationImpl } from './execution';
import type { MigrationTask } from './interactions';
function getCleanupWarningSummary(count: number): string[] {
  return count === 0 ? [] : [`cleanup warnings: ${count}`];
}

function getHardlinkSummary(result: RunMigrationResult): string[] {
  const summary: string[] = [];
  if (result.hardlinkRewrittenFiles.length > 0) {
    summary.push(
      `hard-linked rewrites: ${result.hardlinkRewrittenFiles.length}`,
    );
  }
  if (result.hardlinkSkippedFiles.length > 0) {
    summary.push(`hard-linked skipped: ${result.hardlinkSkippedFiles.length}`);
  }
  return summary;
}

function formatMigrationSummary(
  result: RunMigrationResult,
  cleanupWarningCount = 0,
): string {
  const warnings = getCleanupWarningSummary(cleanupWarningCount);
  const hardlinkSummary = getHardlinkSummary(result);
  return [
    `processing complete: ${result.processingComplete}`,
    `input topology consumable: ${result.inputConsumable}`,
    `dependency comparison complete: ${result.comparisonComplete}`,
    `analysis diagnostics: ${result.analysisDiagnostics.length}`,
    `isolated configs: ${result.isolatedFiles.length}`,
    `outside references removed: ${result.outsideReferenceCount}`,
    `failed or skipped groups: ${result.failedGroups}`,
    `incomplete files: ${result.incompleteFiles.length}`,
    `checker entries: ${result.checkerEntryCount}`,
    `recursive references: ${result.recursiveReferenceCount}`,
    `modified files: ${result.modifiedFiles.length}`,
    ...hardlinkSummary,
    `skipped files: ${result.skippedFiles.length}`,
    ...warnings,
    ...(result.reportPath ? [`audit: ${result.reportPath}`] : []),
  ].join(', ');
}

function reportCleanupWarning(
  warning: MigrationCleanupWarning,
  options: RunMigrationOptions,
): void {
  const message = `${warning.message}\n  recovery path: ${warning.path}`;
  MigrationLogger.warn(message);
  options.flow?.warn(message, { depth: options.flowDepth ?? 0 });
}

function reportMigrationSuccess(options: {
  elapsed: ReturnType<typeof createElapsedTimer>;
  execution: RunMigrationImplResult;
  runOptions: RunMigrationOptions;
  task: MigrationTask;
}): RunMigrationResult {
  for (const warning of options.execution.cleanupWarnings) {
    reportCleanupWarning(warning, options.runOptions);
  }
  const summary = formatMigrationSummary(
    options.execution.result,
    options.execution.cleanupWarnings.length,
  );
  if (options.execution.result.inputConsumable) {
    MigrationLogger.success(
      `migration finished: ${summary}`,
      options.elapsed(),
    );
    completeTask(options.task, summary, true);
  } else {
    MigrationLogger.warn(
      `migration processing finished with incomplete adoption: ${summary}`,
    );
    completeTask(options.task, summary, false);
  }
  return options.execution.result;
}

function handleMigrationError(options: {
  elapsed: ReturnType<typeof createElapsedTimer>;
  error: unknown;
  task: MigrationTask;
}): never {
  MigrationLogger.error(
    `migration failed: ${formatErrorMessage(options.error)}`,
    options.elapsed(),
  );
  options.task?.fail('migration failed', { error: options.error });
  throw options.error;
}

function createMigrationTask(options: RunMigrationOptions): MigrationTask {
  if (options.flow === undefined) {
    return undefined;
  }
  return options.flow.start('migrate tsconfig files', {
    collapseOnSuccess: false,
    depth: options.flowDepth ?? 0,
  });
}

async function executeMigrationCommand(options: {
  config: ResolvedLiminaConfig;
  elapsed: ReturnType<typeof createElapsedTimer>;
  runOptions: RunMigrationOptions;
  task: MigrationTask;
}): Promise<RunMigrationResult> {
  try {
    const execution = await runMigrationImpl(
      options.config,
      resolvePreflight(options.config, options.runOptions),
      {
        runOptions: options.runOptions,
        task: options.task,
      },
    );
    return reportMigrationSuccess({
      elapsed: options.elapsed,
      execution,
      runOptions: options.runOptions,
      task: options.task,
    });
  } catch (error) {
    return handleMigrationError({
      elapsed: options.elapsed,
      error,
      task: options.task,
    });
  }
}

export function runMigration(
  config: ResolvedLiminaConfig,
  options: RunMigrationOptions = {},
): Promise<RunMigrationResult> {
  MigrationLogger.info('migration started');
  return executeMigrationCommand({
    config,
    elapsed: createElapsedTimer(),
    runOptions: options,
    task: createMigrationTask(options),
  });
}

function completeTask(
  task: MigrationTask,
  summary: string,
  isSuccess: boolean,
): void {
  if (!task) return;
  if (isSuccess) task.pass(summary);
  else task.fail(summary);
}
