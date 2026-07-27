import { formatCheckSummaryBlock } from '../../reporting';
import {
  DEFAULT_PRIMARY_BLOCKER_LIMIT,
  type HumanPrimaryBlocker,
  type InventoryQueryContext,
  selectHumanPrimaryBlockers,
} from '../inventory-presentation';
import {
  formatHumanPrimaryBlockerLines,
  formatSeverityTotal,
} from './blockers';
import {
  createCheckRunNextCommands,
  createDefaultInventoryQueryContext,
  type FailedTaskSelection,
  formatNextCommandEntries,
  getFailedTask,
} from './commands';
import type { CheckRunSummaryHumanOptions } from './human-types';
import { createHumanIssueOverview, formatRankedCounts } from './overview';
import {
  formatCheckRunResult,
  formatConfigPath,
  formatDuration,
  formatRunExecutionLines,
  formatSnapshotPath,
  getCheckSummaryBorderColor,
} from './run-metadata';
import { colorCheckStatsLine, formatTaskStatsLines } from './task-stats';

function getVerbose(value: boolean | undefined): boolean {
  return value === true;
}

function selectPrimaryBlockers(options: {
  issues: CheckRunSummaryHumanOptions['issues'];
  verbose: boolean;
}): HumanPrimaryBlocker[] {
  const limit = options.verbose
    ? options.issues.length
    : DEFAULT_PRIMARY_BLOCKER_LIMIT;
  return selectHumanPrimaryBlockers(options.issues, limit);
}

function getQueryContext(
  queryContext: InventoryQueryContext | undefined,
): InventoryQueryContext {
  return queryContext ?? createDefaultInventoryQueryContext();
}

function getRunBlockedLabel(
  run: CheckRunSummaryHumanOptions['run'],
): string | undefined {
  if (run.blockedBy === undefined) return undefined;
  return run.blockedBy.label;
}

function getFailedTaskLabel(failedTask: FailedTaskSelection | null): string {
  return failedTask === null ? '(none)' : failedTask.label;
}

function getBlockedAtLabel(options: {
  failedTask: FailedTaskSelection | null;
  run: CheckRunSummaryHumanOptions['run'];
}): string {
  return (
    getRunBlockedLabel(options.run) ?? getFailedTaskLabel(options.failedTask)
  );
}

function shouldShowBlockedAt(run: CheckRunSummaryHumanOptions['run']): boolean {
  if (run.result === 'blocked') return true;
  return run.blockedBy !== undefined;
}

function shouldShowFailureMetadata(result: string, verbose: boolean): boolean {
  if (result !== 'PASSED') return true;
  return verbose;
}

function formatBlockedAt(options: {
  failedTask: FailedTaskSelection | null;
  run: CheckRunSummaryHumanOptions['run'];
}): string[] {
  if (!shouldShowBlockedAt(options.run)) return [];
  return [`Blocked at: ${getBlockedAtLabel(options)}`];
}

function formatFailureMetadata(options: {
  failedTask: FailedTaskSelection | null;
  result: string;
  rootDir: string | undefined;
  run: CheckRunSummaryHumanOptions['run'];
  verbose: boolean;
}): string[] {
  if (!shouldShowFailureMetadata(options.result, options.verbose)) return [];
  return [
    ...formatBlockedAt(options),
    `Snapshot: ${formatSnapshotPath(options.rootDir)}`,
  ];
}

function formatVerbosePackageCounts(options: {
  packages: ReturnType<typeof createHumanIssueOverview>['packages'];
  verbose: boolean;
}): string[] {
  if (!options.verbose) return [];
  return [
    'Package counts:',
    ...formatRankedCounts(options.packages, options.packages.length),
  ];
}

function formatIssueSections(options: {
  nextCommands: ReturnType<typeof createCheckRunNextCommands>;
  overview: ReturnType<typeof createHumanIssueOverview>;
  primaryBlockers: readonly HumanPrimaryBlocker[];
  verbose: boolean;
}): string[] {
  if (options.overview.issueCount === 0) return [];
  return [
    'Issue overview:',
    `Total: ${formatSeverityTotal(options.overview)}`,
    `Affected packages: ${options.overview.affectedPackages}`,
    `Affected scopes: ${options.overview.affectedScopes}`,
    ...formatVerbosePackageCounts({
      packages: options.overview.packages,
      verbose: options.verbose,
    }),
    'Top rules:',
    ...formatRankedCounts(
      options.overview.rules,
      options.verbose ? options.overview.rules.length : 5,
    ),
    'Primary blockers:',
    ...formatHumanPrimaryBlockerLines(options.primaryBlockers, options.verbose),
    'Next commands:',
    ...formatNextCommandEntries(options.nextCommands),
  ];
}

function createRunSummaryLines(options: {
  failedTask: FailedTaskSelection | null;
  nextCommands: ReturnType<typeof createCheckRunNextCommands>;
  overview: ReturnType<typeof createHumanIssueOverview>;
  primaryBlockers: readonly HumanPrimaryBlocker[];
  request: CheckRunSummaryHumanOptions;
  result: string;
  verbose: boolean;
}): string[] {
  return [
    `Command: ${options.request.run.command}`,
    `Config: ${formatConfigPath(options.request.run, options.request.rootDir)}`,
    `Duration: ${formatDuration(options.request.run.durationMs)}`,
    ...formatRunExecutionLines({
      issueCount: options.overview.issueCount,
      run: options.request.run,
    }),
    ...formatFailureMetadata({
      failedTask: options.failedTask,
      result: options.result,
      rootDir: options.request.rootDir,
      run: options.request.run,
      verbose: options.verbose,
    }),
    'Validation units:',
    ...formatTaskStatsLines({
      issues: options.request.issues,
      run: options.request.run,
      verbose: options.verbose,
    }),
    ...formatIssueSections({
      nextCommands: options.nextCommands,
      overview: options.overview,
      primaryBlockers: options.primaryBlockers,
      verbose: options.verbose,
    }),
  ];
}

export function formatCheckRunSummaryHuman(
  options: CheckRunSummaryHumanOptions,
): string {
  const verbose = getVerbose(options.verbose);
  const overview = createHumanIssueOverview(options.issues);
  const primaryBlockers = selectPrimaryBlockers({
    issues: options.issues,
    verbose,
  });
  const failedTask = getFailedTask(options.run);
  const queryContext = getQueryContext(options.queryContext);
  const nextCommands = createCheckRunNextCommands({
    failedTask,
    queryContext,
    topBlocker: primaryBlockers[0],
  });
  return formatCheckSummaryBlock({
    borderColor: getCheckSummaryBorderColor({
      issues: options.issues,
      run: options.run,
    }),
    color: options.color,
    colorLine: colorCheckStatsLine,
    lines: createRunSummaryLines({
      failedTask,
      nextCommands,
      overview,
      primaryBlockers,
      request: options,
      result: formatCheckRunResult(options.run),
      verbose,
    }),
    title: 'Limina check summary',
  }).join('\n');
}
