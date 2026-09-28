import type { ResolvedLiminaConfig } from '#config/runner';
import { uniqueSortedStrings } from '#utils/collections';
import { plural } from '#utils/reporting';
import { formatSourceIssueBlock } from './block';
import {
  formatFilters,
  formatUnknownRules,
  hasFilters,
  issueMatchesFilters,
} from './filters';
import { formatGenericSourceIssueGroup } from './generic';
import {
  groupGenericSourceIssues,
  groupUnusedModuleIssues,
  groupUnusedWorkspaceDependencyIssues,
} from './groups';
import {
  formatNoMatchedSourceIssues,
  formatSourceReportSummary,
} from './summary';
import type {
  GenericSourceIssueGroup,
  SourceCheckIssue,
  SourceIssueReportOptions,
  SourceUnusedModuleIssue,
  SourceUnusedWorkspaceDependencyIssue,
} from './types';
import { formatUnusedDependencyGroup } from './unused-dependencies';
import { formatUnusedModuleGroup } from './unused-modules';

interface SourceReportGroups {
  generic: GenericSourceIssueGroup[];
  unusedDependencies: SourceUnusedWorkspaceDependencyIssue[][];
  unusedModules: SourceUnusedModuleIssue[][];
}

interface SourceReportContext {
  activeFilters: boolean;
  color: boolean;
  config: ResolvedLiminaConfig;
  filteredIssues: readonly SourceCheckIssue[];
  groups: SourceReportGroups;
  issues: readonly SourceCheckIssue[];
  report: SourceIssueReportOptions;
  unknownRuleLines: readonly string[];
}

function createGroups(issues: readonly SourceCheckIssue[]): SourceReportGroups {
  return {
    generic: groupGenericSourceIssues(issues),
    unusedDependencies: groupUnusedWorkspaceDependencyIssues(issues),
    unusedModules: groupUnusedModuleIssues(issues),
  };
}

function getAvailableRules(issues: readonly SourceCheckIssue[]): string[] {
  return uniqueSortedStrings(issues.map((issue) => issue.code));
}

function createContext(options: {
  color: boolean;
  config: ResolvedLiminaConfig;
  issues: readonly SourceCheckIssue[];
  report?: SourceIssueReportOptions;
}): SourceReportContext {
  const report = options.report ?? {};
  const filteredIssues = options.issues.filter((issue) =>
    issueMatchesFilters(options.config, issue, report),
  );
  return {
    activeFilters: hasFilters(report),
    color: options.color,
    config: options.config,
    filteredIssues,
    groups: createGroups(filteredIssues),
    issues: options.issues,
    report,
    unknownRuleLines: formatUnknownRules(
      report.rules,
      getAvailableRules(options.issues),
    ),
  };
}

function appendUnknownRuleLines(
  lines: string[],
  unknownRuleLines: readonly string[],
): void {
  lines.push(...unknownRuleLines);
  if (unknownRuleLines.length > 0) lines.push('');
}

function isNoMatch(context: SourceReportContext): boolean {
  if (!context.activeFilters) return false;
  return context.filteredIssues.length === 0;
}

function formatMatchedFilterHeader(context: SourceReportContext): string[] {
  if (!context.activeFilters) return [];
  const filterLines = [...formatFilters(context.report), ''];
  if (context.report.verbose !== true) return filterLines;
  return [
    ...filterLines,
    `Matched ${context.filteredIssues.length} ${plural(
      context.filteredIssues.length,
      'issue',
      'issues',
    )}.`,
    '',
  ];
}

function formatSummarySection(context: SourceReportContext): string[] {
  if (context.report.verbose === true && context.activeFilters) return [];
  return formatSourceReportSummary({
    color: context.color,
    groups: context.groups,
  });
}

function appendBlock(options: {
  blockLines: readonly string[];
  color: boolean;
  lines: string[];
  separator: boolean;
}): void {
  if (options.separator && options.lines.length > 0) options.lines.push('');
  options.lines.push(
    ...formatSourceIssueBlock({
      color: options.color,
      lines: options.blockLines,
    }),
  );
}

function appendUnusedModuleBlocks(
  lines: string[],
  context: SourceReportContext,
): void {
  for (const [index, group] of context.groups.unusedModules.entries()) {
    appendBlock({
      blockLines: formatUnusedModuleGroup({
        config: context.config,
        group,
        report: context.report,
      }),
      color: context.color,
      lines,
      separator: index > 0,
    });
  }
}

function appendUnusedDependencyBlocks(
  lines: string[],
  context: SourceReportContext,
): void {
  for (const group of context.groups.unusedDependencies) {
    appendBlock({
      blockLines: formatUnusedDependencyGroup({
        config: context.config,
        group,
        report: context.report,
      }),
      color: context.color,
      lines,
      separator: true,
    });
  }
}

function appendGenericBlocks(
  lines: string[],
  context: SourceReportContext,
): void {
  for (const group of context.groups.generic) {
    appendBlock({
      blockLines: formatGenericSourceIssueGroup({
        config: context.config,
        group,
        report: context.report,
      }),
      color: context.color,
      lines,
      separator: true,
    });
  }
}

function formatNoMatchReport(
  lines: string[],
  context: SourceReportContext,
): string {
  lines.push(
    ...formatNoMatchedSourceIssues({
      issues: context.issues,
      report: context.report,
    }),
  );
  return lines.join('\n');
}

export function formatSourceCheckHumanReport(options: {
  color: boolean;
  config: ResolvedLiminaConfig;
  issues: readonly SourceCheckIssue[];
  report?: SourceIssueReportOptions;
}): string {
  const context = createContext(options);
  const lines: string[] = [];
  appendUnknownRuleLines(lines, context.unknownRuleLines);
  if (isNoMatch(context)) return formatNoMatchReport(lines, context);
  lines.push(
    ...formatMatchedFilterHeader(context),
    ...formatSummarySection(context),
  );
  appendUnusedModuleBlocks(lines, context);
  appendUnusedDependencyBlocks(lines, context);
  appendGenericBlocks(lines, context);
  return lines.join('\n').trim();
}
