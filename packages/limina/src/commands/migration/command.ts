import type { ResolvedLiminaConfig } from '#config/runner';
import { validateUserMaintainedLiminaTsconfigMetadata } from '#core/tsconfig/actions';
import { createElapsedTimer } from 'logaria/helper';
import { formatErrorMessage, MigrationLogger } from '../../logger';
import { type LiminaPreflightManager, resolvePreflight } from '../../preflight';
import { assertCleanGitWorkspace, collectMigrationWorktreeRoots } from './git';
import { collectMigrationTargets } from './targets';
import {
  executeMigrationWritePlan,
  type MigrationCleanupWarning,
} from './transaction';
import { createMigrationWritePlanItem } from './transform';
import type {
  RunMigrationImplResult,
  RunMigrationOptions,
  RunMigrationResult,
} from './types';

async function runMigrationImpl(
  config: ResolvedLiminaConfig,
  preflight: LiminaPreflightManager,
): Promise<RunMigrationImplResult> {
  const context = await preflight.ensureWorkspaceValidated();
  const collection = await collectMigrationTargets(config, context);

  for (const target of collection.targets) {
    validateUserMaintainedLiminaTsconfigMetadata({
      configObject: target.configObject,
      configPath: target.configPath,
    });
  }

  const roots = await collectMigrationWorktreeRoots(collection.targets);
  await Promise.all(roots.map(assertCleanGitWorkspace));
  const plan = collection.targets.map((target) =>
    createMigrationWritePlanItem({ config, target }),
  );
  const execution = await executeMigrationWritePlan(roots, plan);
  return {
    cleanupWarnings: execution.cleanupWarnings,
    result: {
      checkerEntryCount: collection.checkerEntryCount,
      modifiedFiles: execution.modifiedFiles,
      recursiveReferenceCount: collection.recursiveReferenceCount,
      rootDir: config.rootDir,
      skippedFiles: execution.skippedFiles,
    },
  };
}

function getCleanupWarningSummary(count: number): string[] {
  if (count === 0) {
    return [];
  }
  return [`cleanup warnings: ${count}`];
}

function formatMigrationSummary(
  result: RunMigrationResult,
  cleanupWarningCount = 0,
): string {
  const warnings = getCleanupWarningSummary(cleanupWarningCount);
  return [
    `checker entries: ${result.checkerEntryCount}`,
    `recursive references: ${result.recursiveReferenceCount}`,
    `modified files: ${result.modifiedFiles.length}`,
    `skipped files: ${result.skippedFiles.length}`,
    ...warnings,
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

type MigrationTask =
  | ReturnType<NonNullable<RunMigrationOptions['flow']>['start']>
  | undefined;

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
  MigrationLogger.success(`migration finished: ${summary}`, options.elapsed());
  options.task?.pass(summary);
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
