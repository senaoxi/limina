import type { ResolvedLiminaConfig } from '#config/runner';
import {
  isPathCandidatesMatchFileFilters,
  isPathCandidatesMatchScopeFilters,
  type PathFilterCandidate,
} from '../../check-reporting/path-filters';
import { formatShellCommand } from '../../check-reporting/shell-command';
import type {
  SourceCheckIssue,
  SourceIssueReportOptions,
  SourceStructuredIssue,
  SourceUnusedModuleIssue,
} from './types';
import { SOURCE_ISSUE_CODES } from './types';

const DEFAULT_COMMAND = 'limina check';

function hasValues(
  values: readonly string[] | undefined,
): values is readonly string[] {
  return values !== undefined && values.length > 0;
}

export function hasFilters(options: SourceIssueReportOptions): boolean {
  return [
    options.packageNames,
    options.rules,
    options.files,
    options.scopes,
  ].some(hasValues);
}

function formatListFilter(
  label: string,
  values: readonly string[] | undefined,
): string[] {
  return hasValues(values) ? [`  ${label}: ${values.join(', ')}`] : [];
}

export function formatFilters(options: SourceIssueReportOptions): string[] {
  const lines = [
    ...formatListFilter('package', options.packageNames),
    ...formatListFilter('rule', options.rules),
    ...formatListFilter('file', options.files),
    ...formatListFilter('scope', options.scopes),
  ];
  return lines.length > 0 ? ['Filters:', ...lines] : [];
}

function getScopeRelativeTo(
  issue: SourceUnusedModuleIssue | SourceStructuredIssue,
): { scopeRelativeTo?: string[] } {
  return 'ownerDirectory' in issue
    ? { scopeRelativeTo: [issue.ownerDirectory] }
    : {};
}

function getSourceIssuePathCandidates(
  issue: SourceUnusedModuleIssue | SourceStructuredIssue,
): PathFilterCandidate[] {
  if (issue.filePath === undefined) return [];
  return [
    {
      kind: 'file',
      path: issue.filePath,
      ...getScopeRelativeTo(issue),
    },
  ];
}

export function isSourceUnusedModuleIssue(
  issue: SourceCheckIssue,
): issue is SourceUnusedModuleIssue {
  return issue.code === SOURCE_ISSUE_CODES.unusedModule;
}

export function isSourceStructuredIssue(
  issue: SourceCheckIssue,
): issue is SourceStructuredIssue {
  return (
    issue.code !== SOURCE_ISSUE_CODES.unusedModule &&
    issue.code !== SOURCE_ISSUE_CODES.unusedWorkspaceDependency
  );
}

function isFileBackedIssue(
  issue: SourceCheckIssue,
): issue is SourceUnusedModuleIssue | SourceStructuredIssue {
  return (
    isSourceUnusedModuleIssue(issue) ||
    (isSourceStructuredIssue(issue) && issue.filePath !== undefined)
  );
}

function isMatchesPackageFilter(
  issue: SourceCheckIssue,
  packageNames: readonly string[] | undefined,
): boolean {
  return (
    !hasValues(packageNames) ||
    (issue.ownerName !== undefined && packageNames.includes(issue.ownerName))
  );
}

function isMatchesRuleFilter(
  issue: SourceCheckIssue,
  rules: readonly string[] | undefined,
): boolean {
  return !hasValues(rules) || rules.includes(issue.code);
}

function isMatchesFileFilter(options: {
  config: ResolvedLiminaConfig;
  files: readonly string[] | undefined;
  issue: SourceCheckIssue;
}): boolean {
  const files = options.files;
  if (!hasValues(files)) return true;
  if (!isFileBackedIssue(options.issue)) return false;
  return isPathCandidatesMatchFileFilters({
    candidates: getSourceIssuePathCandidates(options.issue),
    files,
    rootDir: options.config.rootDir,
  });
}

function isMatchesScopeFilter(options: {
  config: ResolvedLiminaConfig;
  issue: SourceCheckIssue;
  scopes: readonly string[] | undefined;
}): boolean {
  const scopes = options.scopes;
  if (!hasValues(scopes)) return true;
  if (!isFileBackedIssue(options.issue)) return false;
  return isPathCandidatesMatchScopeFilters({
    candidates: getSourceIssuePathCandidates(options.issue),
    rootDir: options.config.rootDir,
    scopes,
  });
}

export function isIssueMatchesFilters(
  config: ResolvedLiminaConfig,
  issue: SourceCheckIssue,
  options: SourceIssueReportOptions,
): boolean {
  return [
    isMatchesPackageFilter(issue, options.packageNames),
    isMatchesRuleFilter(issue, options.rules),
    isMatchesFileFilter({ config, files: options.files, issue }),
    isMatchesScopeFilter({ config, issue, scopes: options.scopes }),
  ].every(Boolean);
}

function getSubstitutionCost(leftChar: string, rightChar: string): number {
  return leftChar === rightChar ? 0 : 1;
}

function calculateDistanceCell(options: {
  current: readonly number[];
  leftChar: string;
  previous: readonly number[];
  rightChar: string;
  rightIndex: number;
}): number {
  const substitution =
    options.previous[options.rightIndex]! +
    getSubstitutionCost(options.leftChar, options.rightChar);
  const insertion = options.current[options.rightIndex]! + 1;
  const deletion = options.previous[options.rightIndex + 1]! + 1;
  return Math.min(substitution, insertion, deletion);
}

function calculateDistanceRow(options: {
  leftChar: string;
  leftIndex: number;
  previous: readonly number[];
  right: string;
}): number[] {
  const current = [options.leftIndex + 1];
  for (const [rightIndex, rightChar] of [...options.right].entries()) {
    current[rightIndex + 1] = calculateDistanceCell({
      current,
      leftChar: options.leftChar,
      previous: options.previous,
      rightChar,
      rightIndex,
    });
  }
  return current;
}

function levenshteinDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (const [leftIndex, leftChar] of [...left].entries()) {
    previous = calculateDistanceRow({
      leftChar,
      leftIndex,
      previous,
      right,
    });
  }
  return previous[right.length] ?? 0;
}

function compareRuleDistance(
  left: { distance: number; rule: string },
  right: { distance: number; rule: string },
): number {
  const distanceOrder = left.distance - right.distance;
  return distanceOrder === 0
    ? left.rule.localeCompare(right.rule)
    : distanceOrder;
}

function findClosestRule(
  rule: string,
  availableRules: readonly string[],
): string | undefined {
  return availableRules
    .map((availableRule) => ({
      distance: levenshteinDistance(rule, availableRule),
      rule: availableRule,
    }))
    .sort(compareRuleDistance)[0]?.rule;
}

function formatRuleSuggestion(suggestion: string | undefined): string[] | null {
  return suggestion === undefined
    ? null
    : ['', 'Did you mean:', `  - ${suggestion}`];
}

function formatAvailableRules(availableRules: readonly string[]): string[] {
  if (availableRules.length === 0) return [];
  return [
    '',
    'Available rules with issues:',
    ...availableRules.map((item) => `  - ${item}`),
  ];
}

function formatUnknownRule(
  rule: string,
  availableRules: readonly string[],
): string[] {
  const suggested = formatRuleSuggestion(findClosestRule(rule, availableRules));
  return [
    `Unknown issue rule: ${rule}`,
    ...(suggested ?? formatAvailableRules(availableRules)),
  ];
}

export function formatUnknownRules(
  selectedRules: readonly string[] | undefined,
  availableRules: readonly string[],
): string[] {
  return hasValues(selectedRules)
    ? selectedRules
        .filter((rule) => !availableRules.includes(rule))
        .flatMap((rule) => formatUnknownRule(rule, availableRules))
    : [];
}

function formatFlagValues(
  flag: string,
  values: readonly string[] | undefined,
): string[] {
  return (values ?? []).flatMap((value) => [flag, value]);
}

function formatCommandFlags(options: SourceIssueReportOptions): string {
  return formatShellCommand([
    ...formatFlagValues('--package', options.packageNames),
    ...formatFlagValues('--rule', options.rules),
    ...formatFlagValues('--file', options.files),
    ...formatFlagValues('--scope', options.scopes),
  ]);
}

export function createVerboseCommand(
  options: SourceIssueReportOptions,
): string {
  const command = options.command ?? DEFAULT_COMMAND;
  const filterFlags = formatCommandFlags(options);
  return [command, '--verbose', filterFlags].filter(Boolean).join(' ');
}
