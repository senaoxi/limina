import { countDefinedBy } from '#utils/collections';
import { plural } from '#utils/reporting';
import { formatCheckSummaryBlock } from '../../reporting';
import { formatIssueBlock } from './block';
import { formatIssueGroup } from './group-details';
import { hasTruncatedGroups } from './group-truncation';
import {
  createVerboseCommand,
  formatTopCounts,
  groupIssues,
  uniqueCount,
} from './groups';
import type { CheckIssueHumanReportOptions, IssueGroup } from './types';

const DEFAULT_DETAIL_LIMIT = 5;

function createAffectedCountLine(options: {
  count: number;
  label: string;
  pluralValue: string;
  singular: string;
}): string {
  return `${options.label}: ${options.count} ${plural(
    options.count,
    options.singular,
    options.pluralValue,
  )}`;
}

function formatAffectedCount(options: {
  count: number;
  label: string;
  pluralValue: string;
  singular: string;
}): string | null {
  return options.count === 0 ? null : createAffectedCountLine(options);
}

function formatDetailHint(command: string | null): string | null {
  return command === null ? null : `Show all details: ${command}`;
}

function shouldShowDetailHint(options: {
  detailLimit: number;
  groups: readonly IssueGroup[];
  verbose: boolean;
}): boolean {
  if (options.verbose) return false;
  return hasTruncatedGroups(options.groups, options.detailLimit);
}

function createDetailHint(options: {
  command: string | undefined;
  detailLimit: number;
  groups: readonly IssueGroup[];
  verbose: boolean;
}): string | null {
  if (!shouldShowDetailHint(options)) return null;
  return formatDetailHint(createVerboseCommand(options.command));
}

function compactOptionalLines(lines: readonly (string | null)[]): string[] {
  return lines.filter((line): line is string => line !== null);
}

function createSummaryLines(options: {
  command: string | undefined;
  detailLimit: number;
  groups: readonly IssueGroup[];
  issues: CheckIssueHumanReportOptions['issues'];
  verbose: boolean;
}): string[] {
  const packageCount = uniqueCount(
    options.issues,
    (issue) => issue.packageName,
  );
  const scopeCount = uniqueCount(options.issues, (issue) => issue.scope);
  const taskCounts = countDefinedBy(options.issues, (issue) => issue.task);
  const ruleCounts = countDefinedBy(options.issues, (issue) => issue.code);
  return compactOptionalLines([
    `Found ${options.issues.length} ${plural(
      options.issues.length,
      'check issue',
      'check issues',
    )}.`,
    `Failed task: ${formatTopCounts(taskCounts, 3)}`,
    formatAffectedCount({
      count: packageCount,
      label: 'Affected packages',
      pluralValue: 'packages',
      singular: 'package',
    }),
    formatAffectedCount({
      count: scopeCount,
      label: 'Affected scopes',
      pluralValue: 'scopes',
      singular: 'scope',
    }),
    `Top rules: ${formatTopCounts(ruleCounts, 5)}`,
    createDetailHint(options),
  ]);
}

function formatEmptyReport(options: CheckIssueHumanReportOptions): string {
  return formatCheckSummaryBlock({
    color: options.color,
    lines: ['No check issues were reported.'],
    title: options.title,
  }).join('\n');
}

function getDetailLimit(value: number | undefined): number {
  return value === undefined ? DEFAULT_DETAIL_LIMIT : value;
}

function getVerbose(value: boolean | undefined): boolean {
  return value === true;
}

function formatGroupBlock(options: {
  color: boolean;
  detailLimit: number;
  group: IssueGroup;
  verbose: boolean;
}): string[] {
  return [
    '',
    ...formatIssueBlock(
      formatIssueGroup(options.group, {
        detailLimit: options.detailLimit,
        verbose: options.verbose,
      }),
      { color: options.color, severity: options.group.severity },
    ),
  ];
}

function formatGroupBlocks(options: {
  color: boolean;
  detailLimit: number;
  groups: readonly IssueGroup[];
  verbose: boolean;
}): string[] {
  return options.groups.flatMap((group) =>
    formatGroupBlock({ ...options, group }),
  );
}

function formatNonEmptyReport(
  options: CheckIssueHumanReportOptions,
  issues: CheckIssueHumanReportOptions['issues'],
): string {
  const detailLimit = getDetailLimit(options.detailLimit);
  const verbose = getVerbose(options.verbose);
  const groups = groupIssues(issues);
  const summaryLines = createSummaryLines({
    command: options.command,
    detailLimit,
    groups,
    issues,
    verbose,
  });
  return [
    ...formatCheckSummaryBlock({
      color: options.color,
      lines: summaryLines,
      title: options.title,
    }),
    ...formatGroupBlocks({
      color: options.color,
      detailLimit,
      groups,
      verbose,
    }),
  ].join('\n');
}

export function formatCheckIssueHumanReport(
  options: CheckIssueHumanReportOptions,
): string {
  const issues = [...options.issues];
  return issues.length === 0
    ? formatEmptyReport(options)
    : formatNonEmptyReport(options, issues);
}
