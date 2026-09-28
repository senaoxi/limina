import {
  createIssueOverview,
  selectTopBlockers,
} from '../../../check-reporting/summary';
import type {
  CheckIssueInventoryFilters,
  CheckIssueInventoryInvocationMetadata,
  CheckIssueSnapshot,
  LiminaCheckIssue,
} from '../types';

function createInvocationFields(
  invocation: CheckIssueInventoryInvocationMetadata | undefined,
): Record<string, unknown> {
  if (invocation === undefined) return {};
  return {
    completedAt: invocation.completedAt,
    invocationId: invocation.invocationId,
    kind: invocation.kind,
    result: invocation.result,
    version: invocation.version,
  };
}

function createSnapshotFields(
  snapshot: CheckIssueSnapshot | null,
): Record<string, unknown> {
  if (snapshot === null) return { status: 'missing' };
  return {
    command: snapshot.command,
    createdAt: snapshot.createdAt,
    run: snapshot.run,
    status: snapshot.status,
    version: snapshot.version,
  };
}

function createInventoryPayload(options: {
  filteredIssues: readonly LiminaCheckIssue[];
  filters: CheckIssueInventoryFilters;
  invocation?: CheckIssueInventoryInvocationMetadata;
  snapshot: CheckIssueSnapshot | null;
}): Record<string, unknown> {
  return {
    ...createSnapshotFields(options.snapshot),
    filters: options.filters,
    issueCount: options.filteredIssues.length,
    issues: options.filteredIssues,
    overview: createIssueOverview(options.filteredIssues),
    topBlockers: selectTopBlockers(options.filteredIssues),
    ...createInvocationFields(options.invocation),
  };
}

export function formatJsonInventory(options: {
  filteredIssues: readonly LiminaCheckIssue[];
  filters: CheckIssueInventoryFilters;
  invocation?: CheckIssueInventoryInvocationMetadata;
  snapshot: CheckIssueSnapshot | null;
}): string {
  return JSON.stringify(createInventoryPayload(options), null, 2);
}

export function formatNdjsonInventory(
  issues: readonly LiminaCheckIssue[],
): string {
  return issues.map((issue) => JSON.stringify(issue)).join('\n');
}
