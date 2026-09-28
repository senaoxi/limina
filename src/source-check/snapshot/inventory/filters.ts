import {
  pathCandidatesMatchFileFilters,
  pathCandidatesMatchScopeFilters,
  type PathFilterCandidate,
} from '../../../check-reporting/path-filters';
import type {
  CheckIssueInventoryFilters,
  LiminaCheckIssue,
  LiminaCheckIssueLocation,
} from '../types';

export function normalizeFilterValues(
  values: readonly string[] | undefined,
): string[] {
  return (values ?? []).map((value) => value.trim()).filter(Boolean);
}

function getLocationCandidates(
  location: LiminaCheckIssueLocation,
): PathFilterCandidate[] {
  const candidates: PathFilterCandidate[] = [];
  if (location.filePath !== undefined) {
    candidates.push({ kind: 'file', path: location.filePath });
  }
  if (location.packageManifestPath !== undefined) {
    candidates.push({
      kind: 'package-manifest',
      path: location.packageManifestPath,
    });
  }
  return candidates;
}

function getDirectIssueCandidates(
  issue: LiminaCheckIssue,
): PathFilterCandidate[] {
  const candidates: PathFilterCandidate[] = [];
  if (issue.filePath !== undefined) {
    candidates.push({ kind: 'file', path: issue.filePath });
  }
  if (issue.packageManifestPath !== undefined) {
    candidates.push({
      kind: 'package-manifest',
      path: issue.packageManifestPath,
    });
  }
  return candidates;
}

function getIssuePathCandidates(
  issue: LiminaCheckIssue,
): PathFilterCandidate[] {
  return [
    ...getDirectIssueCandidates(issue),
    ...(issue.locations ?? []).flatMap(getLocationCandidates),
  ];
}

function matchesValueFilter(options: {
  actual: string | undefined;
  expected: readonly string[];
}): boolean {
  if (options.expected.length === 0) return true;
  if (options.actual === undefined) return false;
  return options.expected.includes(options.actual);
}

function matchesTaskFilter(
  issue: LiminaCheckIssue,
  values: readonly string[],
): boolean {
  return matchesValueFilter({ actual: issue.task, expected: values });
}

function matchesPackageFilter(
  issue: LiminaCheckIssue,
  values: readonly string[],
): boolean {
  return matchesValueFilter({ actual: issue.packageName, expected: values });
}

function matchesRuleFilter(
  issue: LiminaCheckIssue,
  values: readonly string[],
): boolean {
  return matchesValueFilter({ actual: issue.code, expected: values });
}

function matchesCheckerFilter(
  issue: LiminaCheckIssue,
  values: readonly string[],
): boolean {
  return matchesValueFilter({ actual: issue.checkerName, expected: values });
}

function matchesFileFilter(options: {
  candidates: readonly PathFilterCandidate[];
  files: readonly string[];
  rootDir: string | undefined;
}): boolean {
  if (options.files.length === 0) return true;
  return pathCandidatesMatchFileFilters({
    candidates: options.candidates,
    files: options.files,
    rootDir: options.rootDir,
  });
}

function matchesScopeFilter(options: {
  candidates: readonly PathFilterCandidate[];
  rootDir: string | undefined;
  scopes: readonly string[];
}): boolean {
  if (options.scopes.length === 0) return true;
  return pathCandidatesMatchScopeFilters({
    candidates: options.candidates,
    rootDir: options.rootDir,
    scopes: options.scopes,
  });
}

interface NormalizedInventoryFilters {
  checkers: string[];
  files: string[];
  packages: string[];
  rules: string[];
  scopes: string[];
  tasks: string[];
}

function normalizeInventoryFilters(
  filters: CheckIssueInventoryFilters,
): NormalizedInventoryFilters {
  return {
    checkers: normalizeFilterValues(filters.checkerNames),
    files: normalizeFilterValues(filters.files),
    packages: normalizeFilterValues(filters.packageNames),
    rules: normalizeFilterValues(filters.rules),
    scopes: normalizeFilterValues(filters.scopes),
    tasks: normalizeFilterValues(filters.tasks),
  };
}

function issueMatchesNormalizedFilters(options: {
  filters: NormalizedInventoryFilters;
  issue: LiminaCheckIssue;
  rootDir: string | undefined;
}): boolean {
  const candidates = getIssuePathCandidates(options.issue);
  return [
    matchesTaskFilter(options.issue, options.filters.tasks),
    matchesPackageFilter(options.issue, options.filters.packages),
    matchesRuleFilter(options.issue, options.filters.rules),
    matchesCheckerFilter(options.issue, options.filters.checkers),
    matchesFileFilter({
      candidates,
      files: options.filters.files,
      rootDir: options.rootDir,
    }),
    matchesScopeFilter({
      candidates,
      rootDir: options.rootDir,
      scopes: options.filters.scopes,
    }),
  ].every(Boolean);
}

export function filterInventoryIssues(options: {
  filters: CheckIssueInventoryFilters;
  issues: readonly LiminaCheckIssue[];
  rootDir?: string;
}): LiminaCheckIssue[] {
  const filters = normalizeInventoryFilters(options.filters);
  return options.issues.filter((issue) =>
    issueMatchesNormalizedFilters({
      filters,
      issue,
      rootDir: options.rootDir,
    }),
  );
}
