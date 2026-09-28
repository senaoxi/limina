import type { ResolvedLiminaConfig } from '#config/runner';
import { validateUserMaintainedLiminaTsconfigMetadata } from '#core/tsconfig/actions';
import { createElapsedTimer } from 'logaria/helper';
import path from 'pathe';
import { formatErrorMessage, MigrationLogger } from '../../logger';
import { type LiminaPreflightManager, resolvePreflight } from '../../preflight';
import {
  collectMigrationWorktreeRoots,
  createDirtyWorkspaceDeclinedError,
  createDirtyWorkspacePrompt,
  inspectGitWorkspace,
} from './git';
import { confirmDirtyWorkspace, selectHardlinkStrategy } from './prompts';
import { collectMigrationTargets } from './targets';
import {
  executePreparedMigrationPlan,
  type MigrationCleanupWarning,
  prepareMigrationWritePlan,
} from './transaction';
import { createMigrationWritePlanItem } from './transform';
import type {
  HardlinkMigrationDecision,
  RunMigrationImplResult,
  RunMigrationOptions,
  RunMigrationResult,
} from './types';

type MigrationTask =
  | ReturnType<NonNullable<RunMigrationOptions['flow']>['start']>
  | undefined;

function resolveHardlinkStrategySelection(options: RunMigrationOptions) {
  return options.selectHardlinkStrategy ?? selectHardlinkStrategy;
}

function createHardlinkStrategyPrompt(
  rootDir: string,
  configPaths: readonly string[],
): string {
  const visiblePaths = configPaths.slice(0, 5);
  const remainingCount = configPaths.length - visiblePaths.length;
  const displayedPaths = visiblePaths.map(
    (configPath) => `  ${path.relative(rootDir, configPath)}`,
  );
  if (remainingCount > 0) {
    displayedPaths.push(`  ... and ${remainingCount} more`);
  }
  return [
    `Limina found ${configPaths.length} modified config files with multiple hard links:`,
    '',
    ...displayedPaths,
    '',
    'Replacing these files atomically would break their hard-link relationships.',
    '',
    'Rewriting them in place preserves the links, but all paths referencing the same files will observe the changes and these writes cannot provide atomic replacement guarantees.',
  ].join('\n');
}

async function requestMigrationDecision<Result>(options: {
  request: () => Promise<Result>;
  task: MigrationTask;
}): Promise<Result> {
  await options.task?.pause();
  try {
    return await options.request();
  } finally {
    options.task?.resume();
  }
}

async function decideHardlinkPolicy(options: {
  configRootDir: string;
  hardlinkConfigPaths: readonly string[];
  runOptions: RunMigrationOptions;
  task: MigrationTask;
}): Promise<'rewrite' | 'skip'> {
  if (options.hardlinkConfigPaths.length === 0) return 'skip';
  const selectStrategy = resolveHardlinkStrategySelection(options.runOptions);
  const message = createHardlinkStrategyPrompt(
    options.configRootDir,
    options.hardlinkConfigPaths,
  );
  const decision = await requestMigrationDecision<HardlinkMigrationDecision>({
    request: () => selectStrategy(message),
    task: options.task,
  });
  if (decision === 'cancel') {
    throw new Error('limina migration canceled before writing config files.');
  }
  return decision;
}

function resolveDirtyWorkspaceConfirmation(options: RunMigrationOptions) {
  return options.confirmDirtyWorkspace ?? confirmDirtyWorkspace;
}

async function confirmDirtyWorkspaceChanges(options: {
  roots: readonly string[];
  runOptions: RunMigrationOptions;
  task: MigrationTask;
}): Promise<void> {
  const workspaces = (
    await Promise.all(
      options.roots.map((rootDir) => inspectGitWorkspace(rootDir)),
    )
  ).filter((workspace) => workspace !== undefined);
  if (workspaces.length === 0) return;

  const confirm = resolveDirtyWorkspaceConfirmation(options.runOptions);
  const message = createDirtyWorkspacePrompt(workspaces);
  const accepted = await requestMigrationDecision({
    request: () => confirm(message),
    task: options.task,
  });
  if (accepted) return;

  throw createDirtyWorkspaceDeclinedError(workspaces);
}

async function runMigrationImpl(
  config: ResolvedLiminaConfig,
  preflight: LiminaPreflightManager,
  options: {
    runOptions: RunMigrationOptions;
    task: MigrationTask;
  },
): Promise<RunMigrationImplResult> {
  const context = await preflight.ensureWorkspaceValidated();
  const collection = await collectMigrationTargets(config, context);

  for (const target of collection.targets) {
    validateUserMaintainedLiminaTsconfigMetadata({
      ...target,
      rootDir: config.rootDir,
    });
  }

  const roots = await collectMigrationWorktreeRoots(collection.targets);
  const plan = collection.targets.map((target) =>
    createMigrationWritePlanItem({ config, target }),
  );
  await confirmDirtyWorkspaceChanges({
    roots,
    runOptions: options.runOptions,
    task: options.task,
  });
  const preparedPlan = await prepareMigrationWritePlan(roots, plan);
  const hardlinkPolicy = await decideHardlinkPolicy({
    configRootDir: config.rootDir,
    hardlinkConfigPaths: preparedPlan.hardlinkSnapshots.map(
      (snapshot) => snapshot.item.configPath,
    ),
    runOptions: options.runOptions,
    task: options.task,
  });
  const execution = await executePreparedMigrationPlan(preparedPlan, {
    hardlinkPolicy,
  });
  return {
    cleanupWarnings: execution.cleanupWarnings,
    result: {
      checkerEntryCount: collection.checkerEntryCount,
      hardlinkRewrittenFiles: execution.hardlinkRewrittenFiles,
      hardlinkSkippedFiles: execution.hardlinkSkippedFiles,
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
    `checker entries: ${result.checkerEntryCount}`,
    `recursive references: ${result.recursiveReferenceCount}`,
    `modified files: ${result.modifiedFiles.length}`,
    ...hardlinkSummary,
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
