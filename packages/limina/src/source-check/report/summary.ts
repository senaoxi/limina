import { uniqueSortedStrings } from '#utils/collections';
import { plural } from '#utils/reporting';
import { formatCheckSummaryBlock } from '../../reporting';
import { formatFilters } from './filters';
import type {
  GenericSourceIssueGroup,
  SourceCheckIssue,
  SourceIssueReportOptions,
  SourceUnusedModuleIssue,
  SourceUnusedWorkspaceDependencyIssue,
} from './types';

interface SourceReportGroups {
  generic: readonly GenericSourceIssueGroup[];
  unusedDependencies: readonly (readonly SourceUnusedWorkspaceDependencyIssue[])[];
  unusedModules: readonly (readonly SourceUnusedModuleIssue[])[];
}

function getGroupOwnerNames<T extends { ownerName: string }>(
  groups: readonly (readonly T[])[],
): string[] {
  return uniqueSortedStrings(
    groups.flatMap((group) => {
      const first = group[0];
      return first === undefined ? [] : [first.ownerName];
    }),
  );
}

function countGroupItems<T>(groups: readonly (readonly T[])[]): number {
  return groups.reduce((total, group) => total + group.length, 0);
}

function formatUnusedModuleSummary(
  groups: SourceReportGroups['unusedModules'],
): string[] {
  const issueCount = countGroupItems(groups);
  if (issueCount === 0) return [];
  const packageCount = getGroupOwnerNames(groups).length;
  return [
    `Found ${issueCount} unused source ${plural(
      issueCount,
      'module',
      'modules',
    )} in ${packageCount} ${plural(packageCount, 'package', 'packages')}.`,
  ];
}

function formatUnusedDependencySummary(
  groups: SourceReportGroups['unusedDependencies'],
): string[] {
  const issueCount = countGroupItems(groups);
  if (issueCount === 0) return [];
  const packageCount = getGroupOwnerNames(groups).length;
  return [
    `Found ${issueCount} unused workspace package ${plural(
      issueCount,
      'dependency',
      'dependencies',
    )} in ${packageCount} ${plural(packageCount, 'package', 'packages')}.`,
  ];
}

function getGenericOwnerNames(
  groups: readonly GenericSourceIssueGroup[],
): string[] {
  return uniqueSortedStrings(
    groups.flatMap((group) => {
      const first = group.issues[0];
      return first === undefined ? [] : [first.ownerName];
    }),
  );
}

function countGenericIssues(
  groups: readonly GenericSourceIssueGroup[],
): number {
  return groups.reduce((total, group) => total + group.issues.length, 0);
}

function formatGenericSummary(
  groups: readonly GenericSourceIssueGroup[],
): string[] {
  const issueCount = countGenericIssues(groups);
  if (issueCount === 0) return [];
  const packageCount = getGenericOwnerNames(groups).length;
  return [
    `Found ${issueCount} source check ${plural(
      issueCount,
      'issue',
      'issues',
    )} in ${packageCount} ${plural(packageCount, 'package', 'packages')}.`,
  ];
}

export function formatSourceReportSummary(options: {
  color: boolean;
  groups: SourceReportGroups;
}): string[] {
  const summaryLines = [
    ...formatUnusedModuleSummary(options.groups.unusedModules),
    ...formatUnusedDependencySummary(options.groups.unusedDependencies),
    ...formatGenericSummary(options.groups.generic),
  ];
  if (summaryLines.length === 0) return [];
  return [
    ...formatCheckSummaryBlock({
      color: options.color,
      lines: summaryLines,
      title: 'Source check summary',
    }),
    '',
  ];
}

function formatAvailableValues(options: {
  label: string;
  values: readonly string[];
}): string[] {
  if (options.values.length === 0) return [];
  return ['', options.label, ...options.values.map((value) => `  - ${value}`)];
}

export function formatNoMatchedSourceIssues(options: {
  issues: readonly SourceCheckIssue[];
  report: SourceIssueReportOptions;
}): string[] {
  const packages = uniqueSortedStrings(
    options.issues.map((issue) => issue.ownerName),
  );
  const rules = uniqueSortedStrings(options.issues.map((issue) => issue.code));
  return [
    'No issues matched the selected filters.',
    '',
    ...formatFilters(options.report),
    ...formatAvailableValues({
      label: 'Available packages with issues:',
      values: packages,
    }),
    ...formatAvailableValues({
      label: 'Available rules with issues:',
      values: rules,
    }),
  ];
}
