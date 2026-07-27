import path from 'pathe';
import type { SourceIssueSnapshot } from './types';

function pluralIssue(count: number): string {
  return count === 1 ? 'issue' : 'issues';
}

function incrementCount(groups: Map<string, number>, key: string): void {
  groups.set(key, (groups.get(key) ?? 0) + 1);
}

function compareCountEntries(
  left: readonly [string, number],
  right: readonly [string, number],
): number {
  const countOrder = right[1] - left[1];
  if (countOrder !== 0) return countOrder;
  return left[0].localeCompare(right[0]);
}

function formatCountGroup(
  label: string,
  groups: ReadonlyMap<string, number>,
): string[] {
  const entries = [...groups.entries()].sort(compareCountEntries);
  const values = entries.map(
    ([name, count]) => `  - ${name}  ${count} ${pluralIssue(count)}`,
  );
  return [`${label}:`, ...(values.length === 0 ? ['  (none)'] : values)];
}

function getIssueScope(filePath: string | undefined): string | null {
  if (filePath === undefined) return null;
  const directory = path.posix.dirname(filePath);
  return directory === '.' ? '.' : directory;
}

function createSourceInventoryCounts(snapshot: SourceIssueSnapshot): {
  packages: Map<string, number>;
  rules: Map<string, number>;
  scopes: Map<string, number>;
} {
  const packages = new Map<string, number>();
  const rules = new Map<string, number>();
  const scopes = new Map<string, number>();
  for (const issue of snapshot.issues) {
    incrementCount(packages, issue.ownerName);
    incrementCount(rules, issue.code);
    const scope = getIssueScope(issue.filePath);
    if (scope !== null) incrementCount(scopes, scope);
  }
  return { packages, rules, scopes };
}

function formatMissingSourceSnapshot(): string {
  return [
    'No source issue snapshot found.',
    'Run `limina check` first, then run `limina check --issues`.',
  ].join('\n');
}

function formatIncompleteSourceSnapshot(): string {
  return [
    'No completed source issue snapshot is available from the last run.',
    'Run `limina check` and let it reach source:check first.',
  ].join('\n');
}

function formatEmptySourceSnapshot(): string {
  return [
    'No source issue filters are available from the last run.',
    'The last source check completed without structured source issues.',
    'If `limina check` failed later, that failure came from another task and cannot be filtered with source issue flags.',
  ].join('\n');
}

function getUnavailableInventoryMessage(
  snapshot: SourceIssueSnapshot | null,
): string {
  if (snapshot === null) return formatMissingSourceSnapshot();
  if (snapshot.status !== 'completed') return formatIncompleteSourceSnapshot();
  return formatEmptySourceSnapshot();
}

function isAvailableSourceSnapshot(
  snapshot: SourceIssueSnapshot | null,
): snapshot is SourceIssueSnapshot {
  if (snapshot === null) return false;
  if (snapshot.status !== 'completed') return false;
  return snapshot.issues.length > 0;
}

export function formatSourceIssueSnapshotInventory(
  snapshot: SourceIssueSnapshot | null,
): string {
  if (!isAvailableSourceSnapshot(snapshot)) {
    return getUnavailableInventoryMessage(snapshot);
  }
  const counts = createSourceInventoryCounts(snapshot);
  return [
    'Issue filters available from last run:',
    '',
    ...formatCountGroup('packages', counts.packages),
    '',
    ...formatCountGroup('rules', counts.rules),
    '',
    ...formatCountGroup('scopes', counts.scopes),
  ].join('\n');
}
