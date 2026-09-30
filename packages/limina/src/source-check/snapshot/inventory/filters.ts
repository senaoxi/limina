import {
  isPathCandidatesMatchFileFilters,
  isPathCandidatesMatchScopeFilters,
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

function isMatchesValueFilter(options: {
  actual: string | undefined;
  expected: readonly string[];
}): boolean {
  return (
    options.expected.length === 0 ||
    (options.actual !== undefined && options.expected.includes(options.actual))
  );
}

function isMatchesTaskFilter(
  issue: LiminaCheckIssue,
  values: readonly string[],
): boolean {
  return isMatchesValueFilter({ actual: issue.task, expected: values });
}

function isMatchesPackageFilter(
  issue: LiminaCheckIssue,
  values: readonly string[],
): boolean {
  return isMatchesValueFilter({ actual: issue.packageName, expected: values });
}

function isMatchesRuleFilter(
  issue: LiminaCheckIssue,
  values: readonly string[],
): boolean {
  return isMatchesValueFilter({ actual: issue.code, expected: values });
}

function isMatchesCheckerFilter(
  issue: LiminaCheckIssue,
  values: readonly string[],
): boolean {
  return isMatchesValueFilter({ actual: issue.checkerName, expected: values });
}

function isMatchesFileFilter(options: {
  candidates: readonly PathFilterCandidate[];
  files: readonly string[];
  rootDir: string | undefined;
}): boolean {
  if (options.files.length === 0) return true;
  return isPathCandidatesMatchFileFilters({
    candidates: options.candidates,
    files: options.files,
    rootDir: options.rootDir,
  });
}

function isMatchesScopeFilter(options: {
  candidates: readonly PathFilterCandidate[];
  rootDir: string | undefined;
  scopes: readonly string[];
}): boolean {
  if (options.scopes.length === 0) return true;
  return isPathCandidatesMatchScopeFilters({
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

function isIssueMatchesNormalizedFilters(options: {
  filters: NormalizedInventoryFilters;
  issue: LiminaCheckIssue;
  rootDir: string | undefined;
}): boolean {
  const candidates = getIssuePathCandidates(options.issue);
  return [
    isMatchesTaskFilter(options.issue, options.filters.tasks),
    isMatchesPackageFilter(options.issue, options.filters.packages),
    isMatchesRuleFilter(options.issue, options.filters.rules),
    isMatchesCheckerFilter(options.issue, options.filters.checkers),
    isMatchesFileFilter({
      candidates,
      files: options.filters.files,
      rootDir: options.rootDir,
    }),
    isMatchesScopeFilter({
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
    isIssueMatchesNormalizedFilters({
      filters,
      issue,
      rootDir: options.rootDir,
    }),
  );
}
