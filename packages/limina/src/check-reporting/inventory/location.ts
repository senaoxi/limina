import type {
  LiminaCheckIssue,
  LiminaCheckIssueLocation,
  LiminaCheckIssueSeverity,
} from '../snapshot';
import { createCanonicalIssueFingerprint } from './fingerprint';
import type { RootCauseTuple } from './types';

type CanonicalLocationTuple = readonly [
  label: string,
  filePath: string,
  packageManifestPath: string,
  scope: string,
  line: number | null,
  column: number | null,
];

interface CanonicalLocationCandidate {
  display: string;
  key: string;
}

function optionalString(value: string | undefined): string {
  return value === undefined ? '' : value;
}

function optionalNumber(value: number | undefined): number | null {
  return value === undefined ? null : value;
}

function optionalArray<T>(value: readonly T[] | undefined): readonly T[] {
  return value === undefined ? [] : value;
}

export function compareCodeUnits(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function getIssueSeverityRank(
  severity: LiminaCheckIssueSeverity | undefined,
): number {
  if (severity === 'warning') return 2;
  if (severity === 'info') return 1;
  return 3;
}

function createLocationTuple(
  location: LiminaCheckIssueLocation,
): CanonicalLocationTuple {
  return [
    optionalString(location.label),
    optionalString(location.filePath),
    optionalString(location.packageManifestPath),
    optionalString(location.scope),
    optionalNumber(location.line),
    optionalNumber(location.column),
  ];
}

function getLocationPath(tuple: CanonicalLocationTuple): string {
  if (tuple[1].length > 0) return tuple[1];
  return tuple[2];
}

function formatColumn(column: number | null): string {
  return column === null ? '' : `:${column}`;
}

function formatPosition(options: {
  column: number | null;
  line: number | null;
  pathValue: string;
}): string {
  if (options.pathValue.length === 0) return '';
  if (options.line === null) return '';
  return `:${options.line}${formatColumn(options.column)}`;
}

function getLocationValue(tuple: CanonicalLocationTuple): string {
  const pathValue = getLocationPath(tuple);
  if (pathValue.length > 0) return pathValue;
  return tuple[3];
}

function formatLocationTuple(tuple: CanonicalLocationTuple): string {
  const value = `${getLocationValue(tuple)}${formatPosition({
    column: tuple[5],
    line: tuple[4],
    pathValue: getLocationPath(tuple),
  })}`;
  return [tuple[0], value].filter(Boolean).join(': ');
}

function getLocationKind(tuple: CanonicalLocationTuple): number {
  const index = [tuple[1], tuple[2], tuple[3]].findIndex(
    (value) => value.length > 0,
  );
  return index === -1 ? 3 : index;
}

function createCandidateKey(tuple: CanonicalLocationTuple): string {
  return JSON.stringify([
    getLocationKind(tuple),
    getLocationValue(tuple),
    tuple[0],
    tuple[4],
    tuple[5],
  ]);
}

function createCanonicalLocationCandidate(
  location: LiminaCheckIssueLocation,
): CanonicalLocationCandidate | null {
  const tuple = createLocationTuple(location);
  const display = formatLocationTuple(tuple);
  if (display.length === 0) return null;
  return { display, key: createCandidateKey(tuple) };
}

function addIssueLocation(
  locations: LiminaCheckIssueLocation[],
  field: 'filePath' | 'packageManifestPath' | 'scope',
  value: string | undefined,
): void {
  if (value === undefined) return;
  locations.push({ [field]: value });
}

function collectIssueLocations(
  issue: LiminaCheckIssue,
): LiminaCheckIssueLocation[] {
  const locations: LiminaCheckIssueLocation[] = [];
  addIssueLocation(locations, 'filePath', issue.filePath);
  addIssueLocation(locations, 'packageManifestPath', issue.packageManifestPath);
  addIssueLocation(locations, 'scope', issue.scope);
  locations.push(...optionalArray(issue.locations));
  return locations;
}

function addUniqueCandidate(options: {
  candidate: CanonicalLocationCandidate | null;
  candidates: CanonicalLocationCandidate[];
  seenKeys: Set<string>;
}): void {
  if (options.candidate === null) return;
  if (options.seenKeys.has(options.candidate.key)) return;
  options.seenKeys.add(options.candidate.key);
  options.candidates.push(options.candidate);
}

function getCanonicalLocationCandidates(
  issue: LiminaCheckIssue,
): CanonicalLocationCandidate[] {
  const candidates: CanonicalLocationCandidate[] = [];
  const seenKeys = new Set<string>();
  for (const location of collectIssueLocations(issue)) {
    addUniqueCandidate({
      candidate: createCanonicalLocationCandidate(location),
      candidates,
      seenKeys,
    });
  }
  return candidates.sort((left, right) =>
    compareCodeUnits(left.key, right.key),
  );
}

function getFirstCandidate(
  issue: LiminaCheckIssue,
): CanonicalLocationCandidate | undefined {
  return getCanonicalLocationCandidates(issue)[0];
}

export function getCanonicalIssueLocationKey(issue: LiminaCheckIssue): string {
  const candidate = getFirstCandidate(issue);
  return candidate === undefined ? '' : candidate.key;
}

export function getCanonicalIssueLocation(
  issue: LiminaCheckIssue,
): string | undefined {
  return getFirstCandidate(issue)?.display;
}

export function getAllCanonicalIssueLocations(
  issue: LiminaCheckIssue,
): string[] {
  return getCanonicalLocationCandidates(issue).map(
    (candidate) => candidate.display,
  );
}

function addDefinedPath(paths: string[], value: string | undefined): void {
  if (value !== undefined) paths.push(value);
}

export function getAllIssueFilePaths(issue: LiminaCheckIssue): string[] {
  const paths: string[] = [];
  addDefinedPath(paths, issue.filePath);
  addDefinedPath(paths, issue.packageManifestPath);
  for (const location of optionalArray(issue.locations)) {
    addDefinedPath(paths, location.filePath);
    addDefinedPath(paths, location.packageManifestPath);
  }
  return paths;
}

function firstNonZero(comparisons: readonly number[]): number {
  return comparisons.find((value) => value !== 0) ?? 0;
}

function compareOptionalStrings(
  left: string | undefined,
  right: string | undefined,
): number {
  return compareCodeUnits(optionalString(left), optionalString(right));
}

export function compareCanonicalIssues(
  left: LiminaCheckIssue,
  right: LiminaCheckIssue,
): number {
  const comparisons = [
    getIssueSeverityRank(right.severity) - getIssueSeverityRank(left.severity),
    compareCodeUnits(left.task, right.task),
    compareCodeUnits(left.code, right.code),
    compareCodeUnits(left.title, right.title),
    compareOptionalStrings(left.packageName, right.packageName),
    compareOptionalStrings(left.checkerName, right.checkerName),
    compareOptionalStrings(left.tool, right.tool),
    compareCodeUnits(
      getCanonicalIssueLocationKey(left),
      getCanonicalIssueLocationKey(right),
    ),
    compareOptionalStrings(left.id, right.id),
    compareCodeUnits(
      createCanonicalIssueFingerprint(left),
      createCanonicalIssueFingerprint(right),
    ),
  ];
  return firstNonZero(comparisons);
}

export function createRootCauseTuple(issue: LiminaCheckIssue): RootCauseTuple {
  return [
    issue.task,
    issue.code,
    issue.title,
    optionalString(issue.checkerName),
    optionalString(issue.tool),
    optionalString(issue.domain),
    optionalString(issue.detector),
  ];
}

export function createRootCauseKey(issue: LiminaCheckIssue): string {
  return JSON.stringify(createRootCauseTuple(issue));
}

export function getHighestSeverity(
  issues: readonly LiminaCheckIssue[],
): LiminaCheckIssueSeverity | undefined {
  let highest: LiminaCheckIssueSeverity | undefined;
  let highestRank = -1;
  for (const issue of issues) {
    const rank = getIssueSeverityRank(issue.severity);
    if (rank <= highestRank) continue;
    highest = issue.severity;
    highestRank = rank;
  }
  return highest;
}
