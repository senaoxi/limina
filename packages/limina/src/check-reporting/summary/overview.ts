import { countDefinedBy } from '#utils/collections';
import path from 'pathe';
import { compareCodeUnits } from '../inventory-presentation';
import type { LiminaCheckIssue } from '../snapshot';

const TOP_BLOCKER_LIMIT = 5;
const SEVERITY_RANKS: Readonly<Record<string, number>> = {
  error: 3,
  info: 1,
  warning: 2,
};

export interface CountEntry {
  count: number;
  name: string;
}

export interface CheckIssueOverview {
  affectedFiles: number;
  affectedPackages: number;
  affectedScopes: number;
  checkers: CountEntry[];
  issueCount: number;
  packages: CountEntry[];
  rules: CountEntry[];
  scopes: CountEntry[];
  severities: CountEntry[];
  tasks: CountEntry[];
}

export interface CheckTopBlocker {
  affectedFiles: number;
  affectedPackages: number;
  code: string;
  count: number;
  packages: CountEntry[];
  severity?: string;
  summary?: string;
  task: string;
  title: string;
}

interface BlockerState {
  blocker: CheckTopBlocker;
  files: Set<string>;
  packages: Map<string, number>;
}

type IssueValueSelector = (
  issue: LiminaCheckIssue,
) => string | readonly string[] | undefined;

function compareCountEntries(left: CountEntry, right: CountEntry): number {
  const countOrder = right.count - left.count;
  if (countOrder !== 0) return countOrder;
  return left.name.localeCompare(right.name);
}

function compareHumanCountEntries(left: CountEntry, right: CountEntry): number {
  const countOrder = right.count - left.count;
  if (countOrder !== 0) return countOrder;
  return compareCodeUnits(left.name, right.name);
}

function createCountEntries(
  issues: readonly LiminaCheckIssue[],
  getValue: (issue: LiminaCheckIssue) => string | undefined,
  compare: (left: CountEntry, right: CountEntry) => number,
): CountEntry[] {
  return [...countDefinedBy(issues, getValue).entries()]
    .map(([name, count]) => ({ count, name }))
    .sort(compare);
}

function countBy(
  issues: readonly LiminaCheckIssue[],
  getValue: (issue: LiminaCheckIssue) => string | undefined,
): CountEntry[] {
  return createCountEntries(issues, getValue, compareCountEntries);
}

function countByHuman(
  issues: readonly LiminaCheckIssue[],
  getValue: (issue: LiminaCheckIssue) => string | undefined,
): CountEntry[] {
  return createCountEntries(issues, getValue, compareHumanCountEntries);
}

export function getIssueFilePaths(issue: LiminaCheckIssue): string[] {
  return [
    issue.filePath,
    issue.packageManifestPath,
    ...(issue.locations ?? []).flatMap((location) => [
      location.filePath,
      location.packageManifestPath,
    ]),
  ].filter((value): value is string => Boolean(value));
}

function formatDirectoryScope(filePath: string): string {
  const directory = path.posix.dirname(filePath);
  return directory === '.' ? '.' : directory;
}

export function getIssueScope(issue: LiminaCheckIssue): string | undefined {
  if (issue.scope !== undefined) return issue.scope;
  const filePath = getIssueFilePaths(issue)[0];
  return filePath === undefined ? undefined : formatDirectoryScope(filePath);
}

function addValueList(values: Set<string>, items: readonly string[]): void {
  for (const item of items) values.add(item);
}

function addIssueValues(
  values: Set<string>,
  value: ReturnType<IssueValueSelector>,
): void {
  if (typeof value === 'string') {
    values.add(value);
    return;
  }
  if (value !== undefined) addValueList(values, value);
}

function countUnique(
  issues: readonly LiminaCheckIssue[],
  getValues: IssueValueSelector,
): number {
  const values = new Set<string>();
  for (const issue of issues) addIssueValues(values, getValues(issue));
  return values.size;
}

function createOverview(
  issues: readonly LiminaCheckIssue[],
  counter: typeof countBy,
): CheckIssueOverview {
  return {
    affectedFiles: countUnique(issues, getIssueFilePaths),
    affectedPackages: countUnique(issues, (issue) => issue.packageName),
    affectedScopes: countUnique(issues, getIssueScope),
    checkers: counter(issues, (issue) => issue.checkerName),
    issueCount: issues.length,
    packages: counter(issues, (issue) => issue.packageName),
    rules: counter(issues, (issue) => issue.code),
    scopes: counter(issues, getIssueScope),
    severities: counter(issues, (issue) => issue.severity ?? 'error'),
    tasks: counter(issues, (issue) => issue.task),
  };
}

export function createIssueOverview(
  issues: readonly LiminaCheckIssue[],
): CheckIssueOverview {
  return createOverview(issues, countBy);
}

export function createHumanIssueOverview(
  issues: readonly LiminaCheckIssue[],
): CheckIssueOverview {
  return createOverview(issues, countByHuman);
}

function isStructuredGraphPrepareIssue(issue: LiminaCheckIssue): boolean {
  if (issue.task !== 'graph:prepare') return false;
  return issue.detector === 'graph-prepare';
}

function getTopBlockerKey(issue: LiminaCheckIssue): string {
  if (!isStructuredGraphPrepareIssue(issue)) return issue.code;
  return `${issue.code}\0${issue.title}`;
}

function incrementPackage(
  packages: Map<string, number>,
  packageName: string | undefined,
): void {
  if (packageName === undefined) return;
  packages.set(packageName, (packages.get(packageName) ?? 0) + 1);
}

function createPackageCounts(
  packages: ReadonlyMap<string, number>,
): CountEntry[] {
  return [...packages.entries()]
    .map(([name, count]) => ({ count, name }))
    .sort(compareCountEntries);
}

function createBlockerState(issue: LiminaCheckIssue): BlockerState {
  return {
    blocker: {
      affectedFiles: 0,
      affectedPackages: 0,
      code: issue.code,
      count: 0,
      packages: [],
      severity: issue.severity,
      summary: issue.summary ?? issue.reason,
      task: issue.task,
      title: issue.title,
    },
    files: new Set<string>(),
    packages: new Map<string, number>(),
  };
}

function updateBlockerState(
  state: BlockerState,
  issue: LiminaCheckIssue,
): void {
  for (const filePath of getIssueFilePaths(issue)) state.files.add(filePath);
  incrementPackage(state.packages, issue.packageName);
  state.blocker.affectedFiles = state.files.size;
  state.blocker.affectedPackages = state.packages.size;
  state.blocker.count += 1;
  state.blocker.packages = createPackageCounts(state.packages);
}

function getOrCreateBlockerState(
  states: Map<string, BlockerState>,
  key: string,
  issue: LiminaCheckIssue,
): BlockerState {
  const existing = states.get(key);
  if (existing !== undefined) return existing;
  const created = createBlockerState(issue);
  states.set(key, created);
  return created;
}

function severityRank(severity: string | undefined): number {
  if (severity === undefined) return SEVERITY_RANKS.error!;
  return SEVERITY_RANKS[severity] ?? 1;
}

function firstNonZero(values: readonly number[]): number {
  return values.find((value) => value !== 0) ?? 0;
}

function compareBlockers(
  left: CheckTopBlocker,
  right: CheckTopBlocker,
): number {
  return firstNonZero([
    severityRank(right.severity) - severityRank(left.severity),
    right.count - left.count,
    right.affectedPackages - left.affectedPackages,
    right.affectedFiles - left.affectedFiles,
    left.task.localeCompare(right.task),
    left.code.localeCompare(right.code),
    left.title.localeCompare(right.title),
  ]);
}

export function selectTopBlockers(
  issues: readonly LiminaCheckIssue[],
  limit: number = TOP_BLOCKER_LIMIT,
): CheckTopBlocker[] {
  const states = new Map<string, BlockerState>();
  for (const issue of issues) {
    const key = getTopBlockerKey(issue);
    updateBlockerState(getOrCreateBlockerState(states, key, issue), issue);
  }
  return [...states.values()]
    .map((state) => state.blocker)
    .sort(compareBlockers)
    .slice(0, limit);
}

export function formatTopCounts(
  entries: readonly CountEntry[],
  limit: number,
): string {
  if (entries.length === 0) return '(none)';
  return entries
    .slice(0, limit)
    .map((entry) => `${entry.name} (${entry.count})`)
    .join(', ');
}

export function formatRankedCounts(
  entries: readonly CountEntry[],
  limit: number,
): string[] {
  if (entries.length === 0) return ['  (none)'];
  const visibleEntries = entries.slice(0, limit);
  const countWidth = Math.max(
    ...visibleEntries.map((entry) => String(entry.count).length),
  );
  return visibleEntries.map(
    (entry) => `  ${String(entry.count).padStart(countWidth)}  ${entry.name}`,
  );
}
