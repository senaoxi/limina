import type { ResolvedLiminaConfig } from '#config/runner';
import { normalizeSlashes, toRelativePath } from '#utils/path';
import { plural } from '#utils/reporting';
import path from 'pathe';
import { createVerboseCommand } from './filters';
import type {
  SourceIssueReportOptions,
  SourceUnusedModuleIssue,
} from './types';
import { SOURCE_ISSUE_CODES } from './types';

const DEFAULT_DETAIL_LIMIT = 5;

function getFirstIssue(
  group: readonly SourceUnusedModuleIssue[],
): SourceUnusedModuleIssue | undefined {
  return group[0];
}

function formatUnusedModuleFixes(ownerName: string): string[] {
  return [
    'suggested fixes:',
    '  1. Delete files that are truly unused.',
    '  2. Make files reachable from package manifest entries, binaries, scripts, or Knip plugin entries.',
    '  3. Add intentional files to:',
    `     source.knip.workspaces["${ownerName}"].ignoreFiles`,
    '     with a reason.',
  ];
}

function formatUnusedModuleGroupHeader(options: {
  config: ResolvedLiminaConfig;
  group: readonly SourceUnusedModuleIssue[];
}): string[] {
  const firstIssue = getFirstIssue(options.group);
  if (firstIssue === undefined) return [];
  return [
    firstIssue.ownerName,
    `package manifest: ${toRelativePath(
      options.config.rootDir,
      firstIssue.packageJsonPath,
    )}`,
    `rule: ${SOURCE_ISSUE_CODES.unusedModule}`,
    '',
    'reason:',
    '  Owner-governed source modules must be reachable from package entries, binaries, scripts, or Knip plugin entries.',
    '',
    ...formatUnusedModuleFixes(firstIssue.ownerName),
  ];
}

function formatRemainingFiles(options: {
  count: number;
  report: SourceIssueReportOptions;
}): string[] {
  if (options.count === 0) return [];
  return [
    `  ... ${options.count} more`,
    '',
    'Show all files:',
    `  ${createVerboseCommand(options.report)}`,
  ];
}

function formatDefaultUnusedModuleGroup(options: {
  config: ResolvedLiminaConfig;
  group: readonly SourceUnusedModuleIssue[];
  report: SourceIssueReportOptions;
}): string[] {
  const visibleFiles = options.group.slice(0, DEFAULT_DETAIL_LIMIT);
  return [
    ...formatUnusedModuleGroupHeader(options),
    '',
    'files:',
    ...visibleFiles.map(
      (issue) =>
        `  - ${toRelativePath(options.config.rootDir, issue.filePath)}`,
    ),
    ...formatRemainingFiles({
      count: options.group.length - visibleFiles.length,
      report: options.report,
    }),
  ];
}

function getIssueOwnerScope(issue: SourceUnusedModuleIssue): string {
  const ownerRelativeFile = normalizeSlashes(
    toRelativePath(issue.ownerDirectory, issue.filePath),
  );
  const directory = path.posix.dirname(ownerRelativeFile);
  return directory === '.' ? '<package root>' : directory;
}

function getOrCreateScopeGroup(
  groups: Map<string, SourceUnusedModuleIssue[]>,
  scope: string,
): SourceUnusedModuleIssue[] {
  const existing = groups.get(scope);
  if (existing !== undefined) return existing;
  const created: SourceUnusedModuleIssue[] = [];
  groups.set(scope, created);
  return created;
}

function compareIssues(
  left: SourceUnusedModuleIssue,
  right: SourceUnusedModuleIssue,
): number {
  return left.filePath.localeCompare(right.filePath);
}

function groupIssuesByOwnerScope(
  issues: readonly SourceUnusedModuleIssue[],
): Map<string, SourceUnusedModuleIssue[]> {
  const groups = new Map<string, SourceUnusedModuleIssue[]>();
  for (const issue of issues) {
    getOrCreateScopeGroup(groups, getIssueOwnerScope(issue)).push(issue);
  }
  for (const group of groups.values()) group.sort(compareIssues);
  return new Map(
    [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
}

function formatScopeGroup(options: {
  config: ResolvedLiminaConfig;
  issues: readonly SourceUnusedModuleIssue[];
  scope: string;
}): string[] {
  return [
    `  ${options.scope}  ${options.issues.length} ${plural(
      options.issues.length,
      'file',
      'files',
    )}`,
    ...options.issues.map(
      (issue) =>
        `    - ${toRelativePath(options.config.rootDir, issue.filePath)}`,
    ),
  ];
}

function formatScopeGroups(options: {
  config: ResolvedLiminaConfig;
  group: readonly SourceUnusedModuleIssue[];
}): string[] {
  const groups = [...groupIssuesByOwnerScope(options.group).entries()];
  return groups.flatMap(([scope, issues], index) => [
    ...formatScopeGroup({ config: options.config, issues, scope }),
    ...(index === groups.length - 1 ? [] : ['']),
  ]);
}

function formatVerboseUnusedModuleGroup(options: {
  config: ResolvedLiminaConfig;
  group: readonly SourceUnusedModuleIssue[];
}): string[] {
  return [
    ...formatUnusedModuleGroupHeader(options),
    '',
    'files by scope:',
    '',
    ...formatScopeGroups(options),
  ];
}

export function formatUnusedModuleGroup(options: {
  config: ResolvedLiminaConfig;
  group: readonly SourceUnusedModuleIssue[];
  report: SourceIssueReportOptions;
}): string[] {
  if (options.report.verbose === true) {
    return formatVerboseUnusedModuleGroup(options);
  }
  return formatDefaultUnusedModuleGroup(options);
}
