import type { ResolvedLiminaConfig } from '#config/runner';
import { toRelativePath } from '#utils/path';
import { createVerboseCommand } from './filters';
import type {
  SourceIssueReportOptions,
  SourceUnusedWorkspaceDependencyIssue,
} from './types';
import { SOURCE_ISSUE_CODES } from './types';

const DEFAULT_DETAIL_LIMIT = 5;

function getFirstIssue(
  group: readonly SourceUnusedWorkspaceDependencyIssue[],
): SourceUnusedWorkspaceDependencyIssue | undefined {
  return group[0];
}

function formatUnusedDependencyFixes(ownerName: string): string[] {
  return [
    'suggested fixes:',
    '  1. Remove dependencies that are truly unused from the package manifest.',
    '  2. Make dependencies reachable from package entries, binaries, scripts, or Knip plugin entries.',
    '  3. Add intentional dependencies to:',
    `     source.knip.workspaces["${ownerName}"].ignoreDependencies`,
    '     with dep and reason.',
  ];
}

function formatUnusedDependencyGroupHeader(options: {
  config: ResolvedLiminaConfig;
  group: readonly SourceUnusedWorkspaceDependencyIssue[];
}): string[] {
  const firstIssue = getFirstIssue(options.group);
  if (firstIssue === undefined) return [];
  return [
    firstIssue.ownerName,
    `package manifest: ${toRelativePath(
      options.config.rootDir,
      firstIssue.packageJsonPath,
    )}`,
    `rule: ${SOURCE_ISSUE_CODES.unusedWorkspaceDependency}`,
    '',
    'reason:',
    '  Workspace package dependencies must be reachable from package entries, binaries, scripts, or explicitly ignored when usage is not visible to Knip analysis.',
    '',
    ...formatUnusedDependencyFixes(firstIssue.ownerName),
  ];
}

function formatUnusedDependencyItem(
  issue: SourceUnusedWorkspaceDependencyIssue,
): string[] {
  return [
    `  - ${issue.dependencyName}`,
    `    section: ${issue.sectionName}`,
    `    specifier: ${issue.specifier}`,
  ];
}

function formatRemainingDependencies(options: {
  count: number;
  report: SourceIssueReportOptions;
}): string[] {
  if (options.count === 0) return [];
  return [
    `  ... ${options.count} more`,
    '',
    'Show all dependencies:',
    `  ${createVerboseCommand(options.report)}`,
  ];
}

export function formatUnusedDependencyGroup(options: {
  config: ResolvedLiminaConfig;
  group: readonly SourceUnusedWorkspaceDependencyIssue[];
  report: SourceIssueReportOptions;
}): string[] {
  const visibleIssues =
    options.report.verbose === true
      ? options.group
      : options.group.slice(0, DEFAULT_DETAIL_LIMIT);
  return [
    ...formatUnusedDependencyGroupHeader(options),
    '',
    'dependencies:',
    ...visibleIssues.flatMap(formatUnusedDependencyItem),
    ...formatRemainingDependencies({
      count: options.group.length - visibleIssues.length,
      report: options.report,
    }),
  ];
}
