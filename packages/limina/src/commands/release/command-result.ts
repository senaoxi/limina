import { shouldUseColor } from '#utils/reporting';
import { LiminaStructuredError } from '../../check-reporting/errors';
import { formatCheckIssueHumanReport } from '../../check-reporting/human';
import {
  appendCheckIssues,
  completeCheckIssueSnapshot,
  createTaskFailureIssue,
  type LiminaCheckIssue,
  type LiminaCheckRunCheckItemSummary,
} from '../../check-reporting/snapshot';
import { createCheckItemStats } from '../../check-reporting/stats';
import { formatErrorMessage, ReleaseLogger } from '../../logger';
import type {
  ReleaseCommandContext,
  ReleaseCommandTask,
} from './command-context';
import {
  getReleaseReportCommand,
  getReleaseReportVerbose,
  getSingleReleasePackageName,
  isReleaseInteractiveFlow,
  isReleaseReportDeferred,
  isReleaseSnapshotDeferred,
} from './command-context';
import type {
  ReleaseCheckEntryRunResult,
  RunReleaseCheckOptions,
} from './types';

function passTask(task: ReleaseCommandTask | undefined): void {
  task?.pass();
}

function failTask(
  task: ReleaseCommandTask | undefined,
  reason: string,
  details?: { error: unknown },
): void {
  task?.fail(reason, details);
}

function createReleaseFailureIssue(options: {
  commandOptions: RunReleaseCheckOptions;
  detailLines?: readonly string[];
  fix: string;
  reason: string;
}): LiminaCheckIssue {
  return createTaskFailureIssue({
    code: 'LIMINA_RELEASE_CHECK_FAILED',
    detailLines: options.detailLines,
    filePath: options.commandOptions.config.configPath,
    fix: options.fix,
    packageName: getSingleReleasePackageName(options.commandOptions),
    reason: options.reason,
    rootDir: options.commandOptions.config.rootDir,
    task: 'release:check',
    title: 'Release check failed',
    tool: 'release',
  });
}

function createResultFailureIssue(
  options: RunReleaseCheckOptions,
): LiminaCheckIssue {
  return createReleaseFailureIssue({
    commandOptions: options,
    fix: 'Inspect the release check report above, then rebuild or adjust the selected package output before publishing.',
    reason:
      'Release check found package output or tarball consistency failures.',
  });
}

function createUnexpectedErrorIssue(
  error: unknown,
  options: RunReleaseCheckOptions,
): LiminaCheckIssue {
  const errorMessage = formatErrorMessage(error);
  return createReleaseFailureIssue({
    commandOptions: options,
    detailLines: [errorMessage],
    fix: 'Inspect the release check error above, then rerun `limina release check`.',
    reason: `Release check failed: ${errorMessage}.`,
  });
}

function getErrorIssues(
  error: unknown,
  options: RunReleaseCheckOptions,
): readonly LiminaCheckIssue[] {
  return error instanceof LiminaStructuredError
    ? error.issues
    : [createUnexpectedErrorIssue(error, options)];
}

function selectResultIssues(
  issues: readonly LiminaCheckIssue[],
  options: RunReleaseCheckOptions,
): readonly LiminaCheckIssue[] {
  return issues.length > 0 ? issues : [createResultFailureIssue(options)];
}

function appendDeferredIssues(
  target: LiminaCheckIssue[] | undefined,
  issues: readonly LiminaCheckIssue[],
): void {
  if (target !== undefined) {
    target.push(...issues);
  }
}

async function persistReleaseIssues(
  context: ReleaseCommandContext,
  issues: readonly LiminaCheckIssue[],
): Promise<void> {
  if (isReleaseSnapshotDeferred(context.options)) {
    appendDeferredIssues(context.options.issues, issues);
    return;
  }

  await appendCheckIssues({
    artifactNamespace: context.preflight.artifactNamespace,
    issues,
    rootDir: context.options.config.rootDir,
  });
}

function logIssueReport(
  context: ReleaseCommandContext,
  issues: readonly LiminaCheckIssue[],
): void {
  if (isReleaseReportDeferred(context.options)) {
    return;
  }

  ReleaseLogger.error(
    formatCheckIssueHumanReport({
      color: shouldUseColor(),
      command: getReleaseReportCommand(context.options),
      issues,
      title: 'Release check summary',
      verbose: getReleaseReportVerbose(context.options),
    }),
    context.elapsed(),
  );
}

function createCheckItems(
  entryResults: readonly ReleaseCheckEntryRunResult[],
): LiminaCheckRunCheckItemSummary[] {
  return entryResults.map((result) =>
    createCheckItemStats({
      durationMs: result.durationMs,
      issues: result.passed ? 0 : Math.max(1, result.issues.length),
      name: result.label,
      total: 1,
    }),
  );
}

function countPassedChecks(
  checkItems: readonly LiminaCheckRunCheckItemSummary[],
): number {
  return checkItems.reduce(
    (total, item) => total + (item.checksPassed ?? 0),
    0,
  );
}

export function recordReleaseStats(
  context: ReleaseCommandContext,
  entryResults: readonly ReleaseCheckEntryRunResult[],
): void {
  if (context.options.onStats === undefined) {
    return;
  }

  const items = createCheckItems(entryResults);
  context.options.onStats({
    items,
    passed: countPassedChecks(items),
    total: items.length,
  });
}

function shouldLogSuccess(options: RunReleaseCheckOptions): boolean {
  return [
    !isReleaseReportDeferred(options),
    !isReleaseInteractiveFlow(options),
  ].every(Boolean);
}

export async function handlePassedReleaseCheck(
  context: ReleaseCommandContext,
): Promise<true> {
  if (!isReleaseSnapshotDeferred(context.options)) {
    await completeCheckIssueSnapshot({
      artifactNamespace: context.preflight.artifactNamespace,
      rootDir: context.options.config.rootDir,
    });
  }

  if (shouldLogSuccess(context.options)) {
    ReleaseLogger.success('release check finished', context.elapsed());
  }

  passTask(context.task);
  return true;
}

export async function handleFailedReleaseCheck(
  context: ReleaseCommandContext,
  issues: readonly LiminaCheckIssue[],
): Promise<false> {
  const reportIssues = selectResultIssues(issues, context.options);
  await persistReleaseIssues(context, reportIssues);
  logIssueReport(context, reportIssues);
  failTask(context.task, 'release check finished with failures');
  return false;
}

function getErrorDetails(error: unknown): { error: unknown } | undefined {
  return error instanceof LiminaStructuredError ? undefined : { error };
}

export async function handleReleaseCommandError(
  context: ReleaseCommandContext,
  error: unknown,
): Promise<never> {
  const issues = getErrorIssues(error, context.options);
  await persistReleaseIssues(context, issues);
  logIssueReport(context, issues);
  failTask(context.task, 'release check failed', getErrorDetails(error));
  throw error;
}
