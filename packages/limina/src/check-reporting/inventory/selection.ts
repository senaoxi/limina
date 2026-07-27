import type { LiminaCheckIssue, LiminaCheckIssueSeverity } from '../snapshot';
import {
  compareCanonicalIssues,
  compareCodeUnits,
  createRootCauseKey,
  getHighestSeverity,
  getIssueSeverityRank,
} from './location';

const NO_PACKAGE = Symbol('no-package');
type PackageBucketKey = string | typeof NO_PACKAGE;

interface PackageBucket {
  issues: LiminaCheckIssue[];
  key: PackageBucketKey;
  representative: LiminaCheckIssue;
}

interface RootCauseBucket {
  key: string;
  packageBuckets: PackageBucket[];
  representative: LiminaCheckIssue;
  severity: LiminaCheckIssueSeverity | undefined;
}

interface PackageBucketCursor {
  bucket: PackageBucket;
  issueIndex: number;
}

interface RootCauseBucketCursor {
  bucket: RootCauseBucket;
  nextPackageIndex: number;
  packages: PackageBucketCursor[];
}

function getPackageBucketRank(key: PackageBucketKey): number {
  return key === NO_PACKAGE ? 0 : 1;
}

function comparePackageBucketKeys(
  left: PackageBucketKey,
  right: PackageBucketKey,
): number {
  const rankDifference =
    getPackageBucketRank(left) - getPackageBucketRank(right);
  if (rankDifference !== 0) return rankDifference;
  if (typeof left !== 'string') return 0;
  return compareCodeUnits(left, right as string);
}

function firstNonZero(comparisons: readonly number[]): number {
  return comparisons.find((value) => value !== 0) ?? 0;
}

function comparePackageBuckets(
  left: PackageBucket,
  right: PackageBucket,
): number {
  return firstNonZero([
    comparePackageBucketKeys(left.key, right.key),
    compareCanonicalIssues(left.representative, right.representative),
  ]);
}

function createPackageBucket(
  key: PackageBucketKey,
  issues: readonly LiminaCheckIssue[],
): PackageBucket {
  const sortedIssues = [...issues].sort(compareCanonicalIssues);
  return {
    issues: sortedIssues,
    key,
    representative: sortedIssues[0]!,
  };
}

function getPackageBucketKey(issue: LiminaCheckIssue): PackageBucketKey {
  return issue.packageName === undefined ? NO_PACKAGE : issue.packageName;
}

function getOrCreateIssueGroup<K>(
  groups: Map<K, LiminaCheckIssue[]>,
  key: K,
): LiminaCheckIssue[] {
  const existing = groups.get(key);
  if (existing !== undefined) return existing;
  const created: LiminaCheckIssue[] = [];
  groups.set(key, created);
  return created;
}

function groupByPackage(
  issues: readonly LiminaCheckIssue[],
): Map<PackageBucketKey, LiminaCheckIssue[]> {
  const groups = new Map<PackageBucketKey, LiminaCheckIssue[]>();
  for (const issue of issues) {
    getOrCreateIssueGroup(groups, getPackageBucketKey(issue)).push(issue);
  }
  return groups;
}

function createPackageBuckets(
  issues: readonly LiminaCheckIssue[],
): PackageBucket[] {
  return [...groupByPackage(issues).entries()]
    .map(([key, group]) => createPackageBucket(key, group))
    .sort(comparePackageBuckets);
}

function groupByRootCause(
  issues: readonly LiminaCheckIssue[],
): Map<string, LiminaCheckIssue[]> {
  const groups = new Map<string, LiminaCheckIssue[]>();
  for (const issue of issues) {
    const key = createRootCauseKey(issue);
    getOrCreateIssueGroup(groups, key).push(issue);
  }
  return groups;
}

function createRootCauseBucket(
  key: string,
  issues: readonly LiminaCheckIssue[],
): RootCauseBucket {
  const sortedIssues = [...issues].sort(compareCanonicalIssues);
  return {
    key,
    packageBuckets: createPackageBuckets(issues),
    representative: sortedIssues[0]!,
    severity: getHighestSeverity(issues),
  };
}

function compareRootCauseBuckets(
  left: RootCauseBucket,
  right: RootCauseBucket,
): number {
  return firstNonZero([
    getIssueSeverityRank(right.severity) - getIssueSeverityRank(left.severity),
    compareCanonicalIssues(left.representative, right.representative),
    compareCodeUnits(left.key, right.key),
  ]);
}

function createRootCauseBuckets(
  issues: readonly LiminaCheckIssue[],
): RootCauseBucket[] {
  return [...groupByRootCause(issues).entries()]
    .map(([key, group]) => createRootCauseBucket(key, group))
    .sort(compareRootCauseBuckets);
}

function createRootCauseCursor(bucket: RootCauseBucket): RootCauseBucketCursor {
  return {
    bucket,
    nextPackageIndex: 0,
    packages: bucket.packageBuckets.map((packageBucket) => ({
      bucket: packageBucket,
      issueIndex: 0,
    })),
  };
}

function takeNextRootCauseIssue(
  cursor: RootCauseBucketCursor,
): LiminaCheckIssue | undefined {
  const packageCount = cursor.packages.length;
  for (let attempt = 0; attempt < packageCount; attempt += 1) {
    const packageIndex = cursor.nextPackageIndex % packageCount;
    const packageCursor = cursor.packages[packageIndex]!;
    cursor.nextPackageIndex = (packageIndex + 1) % packageCount;
    if (packageCursor.issueIndex >= packageCursor.bucket.issues.length) {
      continue;
    }
    const issue = packageCursor.bucket.issues[packageCursor.issueIndex];
    packageCursor.issueIndex += 1;
    return issue;
  }
  return undefined;
}

function selectCursorIssue(options: {
  cursor: RootCauseBucketCursor;
  selected: LiminaCheckIssue[];
  selectionLimit: number;
}): boolean {
  if (options.selected.length >= options.selectionLimit) return false;
  const issue = takeNextRootCauseIssue(options.cursor);
  if (issue === undefined) return false;
  options.selected.push(issue);
  return true;
}

function selectRound(options: {
  cursors: readonly RootCauseBucketCursor[];
  selected: LiminaCheckIssue[];
  selectionLimit: number;
}): boolean {
  let selectedInRound = false;
  for (const cursor of options.cursors) {
    if (selectCursorIssue({ ...options, cursor })) {
      selectedInRound = true;
    }
  }
  return selectedInRound;
}

function getSelectionLimit(
  issues: readonly LiminaCheckIssue[],
  maxIssues: number | null,
): number {
  return maxIssues === null ? issues.length : maxIssues;
}

function isDisabledSelection(maxIssues: number | null): boolean {
  if (maxIssues === null) return false;
  return maxIssues <= 0;
}

function collectSelectedIssues(options: {
  cursors: readonly RootCauseBucketCursor[];
  selectionLimit: number;
}): LiminaCheckIssue[] {
  const selected: LiminaCheckIssue[] = [];
  while (selected.length < options.selectionLimit) {
    const changed = selectRound({ ...options, selected });
    if (!changed) break;
  }
  return selected;
}

export function selectInventoryIssues(
  issues: readonly LiminaCheckIssue[],
  maxIssues: number | null,
): LiminaCheckIssue[] {
  if (isDisabledSelection(maxIssues)) return [];
  return collectSelectedIssues({
    cursors: createRootCauseBuckets(issues).map(createRootCauseCursor),
    selectionLimit: getSelectionLimit(issues, maxIssues),
  });
}
