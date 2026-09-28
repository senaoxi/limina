import type { LiminaCheckIssue } from '../snapshot';
import {
  compareCanonicalIssues,
  compareCodeUnits,
  createRootCauseKey,
  getAllIssueFilePaths,
  getCanonicalIssueLocation,
  getHighestSeverity,
  getIssueSeverityRank,
} from './location';
import {
  DEFAULT_PRIMARY_BLOCKER_LIMIT,
  type HumanCountEntry,
  type HumanPrimaryBlocker,
  type MutableHumanPrimaryBlocker,
} from './types';

function incrementMapCount(counts: Map<string, number>, value: string): void {
  counts.set(value, (counts.get(value) ?? 0) + 1);
}

function firstNonZero(comparisons: readonly number[]): number {
  return comparisons.find((value) => value !== 0) ?? 0;
}

function compareHumanPrimaryBlockers(
  left: HumanPrimaryBlocker,
  right: HumanPrimaryBlocker,
): number {
  return firstNonZero([
    getIssueSeverityRank(right.severity) - getIssueSeverityRank(left.severity),
    right.count - left.count,
    right.affectedPackages - left.affectedPackages,
    right.affectedFiles - left.affectedFiles,
    compareCanonicalIssues(left.representative, right.representative),
    compareCodeUnits(
      createRootCauseKey(left.representative),
      createRootCauseKey(right.representative),
    ),
  ]);
}

function createMutableBlocker(key: string): MutableHumanPrimaryBlocker {
  return {
    files: new Set(),
    issues: [],
    key,
    packageCounts: new Map(),
  };
}

function addIssueFiles(
  group: MutableHumanPrimaryBlocker,
  issue: LiminaCheckIssue,
): void {
  for (const filePath of getAllIssueFilePaths(issue)) {
    group.files.add(filePath);
  }
}

function addIssuePackage(
  group: MutableHumanPrimaryBlocker,
  issue: LiminaCheckIssue,
): void {
  if (issue.packageName === undefined) return;
  incrementMapCount(group.packageCounts, issue.packageName);
}

function groupBlockerIssues(
  issues: readonly LiminaCheckIssue[],
): Map<string, MutableHumanPrimaryBlocker> {
  const groups = new Map<string, MutableHumanPrimaryBlocker>();
  for (const issue of issues) {
    const key = createRootCauseKey(issue);
    const group = groups.get(key) ?? createMutableBlocker(key);
    addIssueFiles(group, issue);
    addIssuePackage(group, issue);
    group.issues.push(issue);
    groups.set(key, group);
  }
  return groups;
}

function comparePackageCounts(
  left: HumanCountEntry,
  right: HumanCountEntry,
): number {
  if (left.count !== right.count) return right.count - left.count;
  return compareCodeUnits(left.name, right.name);
}

function createPackageCounts(
  counts: ReadonlyMap<string, number>,
): HumanCountEntry[] {
  return [...counts.entries()]
    .map(([name, count]) => ({ count, name }))
    .sort(comparePackageCounts);
}

function createPrimaryBlocker(
  group: MutableHumanPrimaryBlocker,
): HumanPrimaryBlocker {
  const sortedIssues = [...group.issues].sort(compareCanonicalIssues);
  const representative = sortedIssues[0]!;
  const packages = createPackageCounts(group.packageCounts);
  return {
    affectedFiles: group.files.size,
    affectedPackages: packages.length,
    checkerName: representative.checkerName,
    code: representative.code,
    count: group.issues.length,
    detector: representative.detector,
    domain: representative.domain,
    packages,
    representative,
    representativeLocation: getCanonicalIssueLocation(representative),
    severity: getHighestSeverity(group.issues),
    summary: representative.summary ?? representative.reason,
    task: representative.task,
    title: representative.title,
    tool: representative.tool,
  };
}

export function selectHumanPrimaryBlockers(
  issues: readonly LiminaCheckIssue[],
  limit: number = DEFAULT_PRIMARY_BLOCKER_LIMIT,
): HumanPrimaryBlocker[] {
  return [...groupBlockerIssues(issues).values()]
    .map(createPrimaryBlocker)
    .sort(compareHumanPrimaryBlockers)
    .slice(0, Math.max(0, limit));
}
