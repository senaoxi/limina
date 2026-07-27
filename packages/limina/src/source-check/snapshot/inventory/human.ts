import { formatCheckIssueInventoryCard } from '../../../check-reporting/human';
import {
  getCanonicalIssueLocation,
  selectInventoryIssues,
} from '../../../check-reporting/inventory-presentation';
import { formatCheckIssueSnapshotSummaryHuman } from '../../../check-reporting/summary';
import type {
  CheckIssueInventoryHumanOptions,
  LiminaCheckIssue,
} from '../types';

function formatInvocationHeader(
  options: CheckIssueInventoryHumanOptions,
): string[] {
  const invocation = options.invocation;
  if (invocation === undefined) return [];
  return [
    `Invocation: ${invocation.invocationId}`,
    `Kind: ${invocation.kind}`,
    `Result: ${invocation.result}`,
    `Completed: ${invocation.completedAt}`,
    '',
  ];
}

function formatHumanSummary(options: {
  filteredIssues: readonly LiminaCheckIssue[];
  inventory: CheckIssueInventoryHumanOptions;
}): string {
  const snapshot = options.inventory.snapshot;
  if (snapshot === null) return '';
  const issueSummary = formatCheckIssueSnapshotSummaryHuman({
    color: options.inventory.color,
    filteredIssueCount: options.filteredIssues.length,
    filters: options.inventory.queryContext.filters,
    issues: options.filteredIssues,
    presentation: options.inventory.presentation,
    queryContext: options.inventory.queryContext,
    rootDir: options.inventory.rootDir,
    snapshot,
    totalIssueCount: snapshot.issues.length,
  });
  return [...formatInvocationHeader(options.inventory), issueSummary].join(
    '\n',
  );
}

function formatIssueCards(options: {
  inventory: CheckIssueInventoryHumanOptions;
  issues: readonly LiminaCheckIssue[];
}): string[] {
  const view = options.inventory.presentation.view;
  if (view === 'summary') return [];
  return options.issues.flatMap((issue) => [
    '',
    formatCheckIssueInventoryCard({
      color: options.inventory.color,
      issue,
      representativeLocation: getCanonicalIssueLocation(issue),
      view,
    }),
  ]);
}

function shouldReturnSummaryOnly(options: {
  filteredIssueCount: number;
  inventory: CheckIssueInventoryHumanOptions;
}): boolean {
  if (options.inventory.presentation.view === 'summary') return true;
  return options.filteredIssueCount === 0;
}

export function formatCompletedHumanInventory(options: {
  filteredIssues: readonly LiminaCheckIssue[];
  inventory: CheckIssueInventoryHumanOptions;
}): string {
  const summary = formatHumanSummary(options);
  if (
    shouldReturnSummaryOnly({
      filteredIssueCount: options.filteredIssues.length,
      inventory: options.inventory,
    })
  ) {
    return summary;
  }
  const selectedIssues = selectInventoryIssues(
    options.filteredIssues,
    options.inventory.presentation.maxIssues,
  );
  return [
    summary,
    '',
    `Showing ${selectedIssues.length} of ${options.filteredIssues.length} issues`,
    ...formatIssueCards({
      inventory: options.inventory,
      issues: selectedIssues,
    }),
  ].join('\n');
}
