import { formatCheckSummaryBlock } from '../../reporting';
import { selectHumanPrimaryBlockers } from '../inventory-presentation';
import { formatHumanPrimaryBlockerLines } from './blockers';
import {
  createIssueSnapshotNextCommands,
  formatNextCommandEntries,
} from './commands';
import { formatFilterDiagnostics, formatFilters } from './filters';
import type { CheckIssueSnapshotSummaryHumanOptions } from './human-types';
import {
  createHumanIssueOverview,
  formatRankedCounts,
  formatTopCounts,
} from './overview';
import {
  formatSnapshotTimestamp,
  getCheckSummaryBorderColor,
} from './run-metadata';

function getIssueCount(
  configuredCount: number | undefined,
  issues: CheckIssueSnapshotSummaryHumanOptions['issues'],
): number {
  return configuredCount ?? issues.length;
}

function getSnapshotCommand(
  options: CheckIssueSnapshotSummaryHumanOptions,
): string {
  return options.snapshot.run?.command ?? options.snapshot.command;
}

function createSnapshotSummaryLines(options: {
  filteredIssueCount: number;
  nextCommands: ReturnType<typeof createIssueSnapshotNextCommands>;
  overview: ReturnType<typeof createHumanIssueOverview>;
  primaryBlockers: ReturnType<typeof selectHumanPrimaryBlockers>;
  request: CheckIssueSnapshotSummaryHumanOptions;
  totalIssueCount: number;
}): string[] {
  return [
    `Snapshot: ${formatSnapshotTimestamp(options.request.snapshot)}`,
    `Command: ${getSnapshotCommand(options.request)}`,
    `Status: ${options.request.snapshot.status}`,
    `Matched: ${options.filteredIssueCount} / ${options.totalIssueCount} issues`,
    ...formatFilters(options.request.filters),
    ...formatFilterDiagnostics({
      filters: options.request.filters,
      queryContext: options.request.queryContext,
      snapshot: options.request.snapshot,
    }),
    'Issue overview:',
    `Tasks: ${formatTopCounts(options.overview.tasks, 5)}`,
    `Packages: ${formatTopCounts(options.overview.packages, 5)}`,
    'Top rules:',
    ...formatRankedCounts(options.overview.rules, 5),
    'Primary blockers:',
    ...formatHumanPrimaryBlockerLines(options.primaryBlockers, false),
    'Next commands:',
    ...formatNextCommandEntries(options.nextCommands),
  ];
}

export function formatCheckIssueSnapshotSummaryHuman(
  options: CheckIssueSnapshotSummaryHumanOptions,
): string {
  const overview = createHumanIssueOverview(options.issues);
  const primaryBlockers = selectHumanPrimaryBlockers(
    options.issues,
    options.presentation.maxPrimaryBlockers,
  );
  const nextCommands = createIssueSnapshotNextCommands({
    presentation: options.presentation,
    primaryBlocker: primaryBlockers[0],
    queryContext: options.queryContext,
  });
  return formatCheckSummaryBlock({
    borderColor: getCheckSummaryBorderColor({
      issues: options.snapshot.issues,
      run: options.snapshot.run,
    }),
    color: options.color,
    lines: createSnapshotSummaryLines({
      filteredIssueCount: getIssueCount(
        options.filteredIssueCount,
        options.issues,
      ),
      nextCommands,
      overview,
      primaryBlockers,
      request: options,
      totalIssueCount: getIssueCount(options.totalIssueCount, options.issues),
    }),
    title: 'Limina check issue summary',
  }).join('\n');
}
