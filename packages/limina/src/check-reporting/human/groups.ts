import { uniqueSortedStrings } from '#utils/collections';
import type { LiminaCheckIssue, LiminaCheckIssueLocation } from '../snapshot';
import type { IssueGroup } from './types';

const ANSI_BLUE = '\u001B[34m';
const ANSI_CYAN = '\u001B[36m';
const ANSI_GREEN = '\u001B[32m';
const ANSI_MAGENTA = '\u001B[35m';
const ANSI_RED = '\u001B[31m';
const ANSI_YELLOW = '\u001B[33m';

const LABEL_COLORS = new Map<string, string>([
  ['fix', ANSI_GREEN],
  ['fix steps', ANSI_GREEN],
  ['suggested fix', ANSI_GREEN],
  ['reason', ANSI_YELLOW],
  ['evidence', ANSI_MAGENTA],
  ['external', ANSI_MAGENTA],
  ['details', ANSI_MAGENTA],
  ['rule', ANSI_BLUE],
  ['task', ANSI_BLUE],
]);

export function getSeverityColor(severity: string | undefined): string {
  if (severity === 'warning') return ANSI_YELLOW;
  if (severity === 'info') return ANSI_CYAN;
  return ANSI_RED;
}

export function getLabelColor(label: string): string {
  return LABEL_COLORS.get(label.toLowerCase()) ?? ANSI_CYAN;
}

export function formatTopCounts(
  counts: Map<string, number>,
  limit: number,
): string {
  return [...counts.entries()]
    .sort(([leftValue, leftCount], [rightValue, rightCount]) => {
      const countOrder = rightCount - leftCount;
      return countOrder === 0
        ? leftValue.localeCompare(rightValue)
        : countOrder;
    })
    .slice(0, limit)
    .map(([value, count]) => `${value} (${count})`)
    .join(', ');
}

export function uniqueCount(
  issues: readonly LiminaCheckIssue[],
  getValue: (issue: LiminaCheckIssue) => string | undefined,
): number {
  return new Set(issues.map(getValue).filter(Boolean)).size;
}

function appendVerboseFlag(command: string): string {
  return command.split(/\s+/u).includes('--verbose')
    ? command
    : `${command} --verbose`;
}

export function createVerboseCommand(
  command: string | undefined,
): string | null {
  if (!command) return null;
  return appendVerboseFlag(command);
}

function valueOrEmpty(value: string | undefined): string {
  return value ?? '';
}

function jsonOrNull(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function getGroupKey(issue: LiminaCheckIssue): string {
  const fields = [
    issue.task,
    issue.code,
    issue.title,
    valueOrEmpty(issue.summary),
    valueOrEmpty(issue.packageName),
    valueOrEmpty(issue.packageManifestPath),
    valueOrEmpty(issue.checkerName),
    valueOrEmpty(issue.tool),
    valueOrEmpty(issue.domain),
    valueOrEmpty(issue.detector),
    jsonOrNull(issue.external),
    issue.reason,
    valueOrEmpty(issue.fix),
    jsonOrNull(issue.fixSteps),
    jsonOrNull(issue.verifyCommands),
  ];
  return fields.join('\0');
}

function createIssueGroup(issue: LiminaCheckIssue): IssueGroup {
  return {
    checkerName: issue.checkerName,
    code: issue.code,
    detector: issue.detector,
    domain: issue.domain,
    external: issue.external,
    fix: issue.fix,
    fixSteps: issue.fixSteps,
    issues: [],
    packageManifestPath: issue.packageManifestPath,
    packageName: issue.packageName,
    reason: issue.reason,
    severity: issue.severity,
    summary: issue.summary,
    task: issue.task,
    title: issue.title,
    tool: issue.tool,
    verifyCommands: issue.verifyCommands,
  };
}

function compareGroupField(left: string, right: string): number {
  return left.localeCompare(right);
}

function compareGroups(left: IssueGroup, right: IssueGroup): number {
  const fields: readonly [string, string][] = [
    [left.task, right.task],
    [left.code, right.code],
    [valueOrEmpty(left.packageName), valueOrEmpty(right.packageName)],
    [valueOrEmpty(left.checkerName), valueOrEmpty(right.checkerName)],
    [valueOrEmpty(left.tool), valueOrEmpty(right.tool)],
    [left.title, right.title],
  ];
  for (const [leftValue, rightValue] of fields) {
    const order = compareGroupField(leftValue, rightValue);
    if (order !== 0) return order;
  }
  return 0;
}

export function groupIssues(issues: readonly LiminaCheckIssue[]): IssueGroup[] {
  const groups = new Map<string, IssueGroup>();
  for (const issue of issues) {
    const key = getGroupKey(issue);
    const group = groups.get(key) ?? createIssueGroup(issue);
    group.issues.push(issue);
    groups.set(key, group);
  }
  return [...groups.values()].sort(compareGroups);
}

function getManifestLocation(
  location: LiminaCheckIssueLocation,
): string | undefined {
  if (location.packageManifestPath === undefined) return undefined;
  return `package manifest: ${location.packageManifestPath}`;
}

function getLocationFilePath(
  location: LiminaCheckIssueLocation,
): string | undefined {
  return location.filePath ?? getManifestLocation(location);
}

function formatPosition(location: LiminaCheckIssueLocation): string {
  if (location.line === undefined) return '';
  if (location.column === undefined) return `:${location.line}`;
  return `:${location.line}:${location.column}`;
}

function getLocationText(
  location: LiminaCheckIssueLocation,
): string | undefined {
  const filePath = getLocationFilePath(location);
  if (filePath === undefined) return location.scope;
  return `${filePath}${formatPosition(location)}`;
}

export function formatLocation(location: LiminaCheckIssueLocation): string {
  return [location.label, getLocationText(location)].filter(Boolean).join(': ');
}

function getFallbackIssueLocation(issue: LiminaCheckIssue): string {
  const values = [
    issue.filePath,
    issue.packageManifestPath,
    issue.scope,
    issue.checkerName,
    issue.tool,
    issue.title,
  ];
  return values.find((value) => value !== undefined) ?? issue.title;
}

export function getIssueLocations(issue: LiminaCheckIssue): string[] {
  const structuredLocations = (issue.locations ?? [])
    .map(formatLocation)
    .map((value) => value.trim())
    .filter(Boolean);
  if (structuredLocations.length > 0) return structuredLocations;
  return [getFallbackIssueLocation(issue)];
}

export function getIssueLocation(issue: LiminaCheckIssue): string {
  return getIssueLocations(issue)[0] ?? issue.title;
}

export function getGroupLocations(group: IssueGroup): string[] {
  return uniqueSortedStrings(
    group.issues
      .flatMap(getIssueLocations)
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

function hasFileLocation(issue: LiminaCheckIssue): boolean {
  if (issue.filePath !== undefined) return true;
  return (issue.locations ?? []).some((location) => {
    if (location.filePath !== undefined) return true;
    return location.packageManifestPath !== undefined;
  });
}

function hasDirectFilePath(issue: LiminaCheckIssue): boolean {
  return issue.filePath !== undefined;
}

function hasCheckerName(issue: LiminaCheckIssue): boolean {
  return issue.checkerName !== undefined;
}

export function getGroupLocationsHeading(group: IssueGroup): string {
  const headings = [
    { heading: 'files:', match: group.issues.some(hasDirectFilePath) },
    { heading: 'locations:', match: group.issues.some(hasFileLocation) },
    { heading: 'targets:', match: group.issues.some(hasCheckerName) },
  ];
  return headings.find((candidate) => candidate.match)?.heading ?? 'items:';
}
