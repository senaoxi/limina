import type { ResolvedLiminaConfig } from '#config/runner';
import { uniqueSortedStrings } from '#utils/collections';
import { plural } from '#utils/reporting';
import { createVerboseCommand } from './filters';
import {
  formatSourceEvidence,
  formatSourceIssuePath,
  getGenericSourceIssueDisplayLocation,
} from './locations';
import type {
  GenericSourceIssueGroup,
  SourceIssueReportOptions,
  SourceStructuredIssue,
} from './types';

const DEFAULT_DETAIL_LIMIT = 5;

function getFirstIssue(
  group: GenericSourceIssueGroup,
): SourceStructuredIssue | undefined {
  return group.issues[0];
}

function getVisibleLocations(options: {
  locations: readonly string[];
  verbose: boolean;
}): readonly string[] {
  return options.verbose
    ? options.locations
    : options.locations.slice(0, DEFAULT_DETAIL_LIMIT);
}

function getConfiguredFixSteps(
  issue: SourceStructuredIssue,
): readonly string[] | null {
  const configured = issue.fixSteps;
  if (configured === undefined) return null;
  return configured.length === 0 ? null : configured;
}

function getFixSteps(issue: SourceStructuredIssue): readonly string[] {
  const configured = getConfiguredFixSteps(issue);
  if (configured !== null) return configured;
  return issue.fix === undefined ? [] : [issue.fix];
}

function formatPackageManifest(
  config: ResolvedLiminaConfig,
  issue: SourceStructuredIssue,
): string[] {
  if (issue.packageJsonPath === undefined) return [];
  return [
    `package manifest: ${formatSourceIssuePath(
      config.rootDir,
      issue.packageJsonPath,
    )}`,
  ];
}

function formatMetadata(issue: SourceStructuredIssue): string[] {
  const lines: string[] = [];
  if (issue.detector !== undefined) lines.push(`detector: ${issue.detector}`);
  if (issue.tool !== undefined) lines.push(`tool: ${issue.tool}`);
  return lines;
}

function formatSummary(issue: SourceStructuredIssue): string[] {
  return issue.summary === undefined
    ? []
    : ['summary:', `  ${issue.summary}`, ''];
}

function formatFixSection(issue: SourceStructuredIssue): string[] {
  const steps = getFixSteps(issue);
  if (steps.length === 0) return [];
  return [
    '',
    'fix steps:',
    ...steps.map((step, index) => `  ${index + 1}. ${step}`),
  ];
}

function formatVerifySection(issue: SourceStructuredIssue): string[] {
  const commands = issue.verifyCommands;
  return commands === undefined || commands.length === 0
    ? []
    : ['', 'verify:', ...commands.map((command) => `  - ${command}`)];
}

function formatEvidenceSection(issue: SourceStructuredIssue): string[] {
  const lines = formatSourceEvidence(issue.evidence);
  return lines.length === 0 ? [] : ['', ...lines];
}

function formatVerboseDetails(
  issues: readonly SourceStructuredIssue[],
): string[] {
  return issues.flatMap((issue) => {
    const detailLines = issue.detailLines;
    return detailLines === undefined || detailLines.length === 0
      ? []
      : ['', ...detailLines.map((line) => `    ${line}`)];
  });
}

function getDetailsHeading(isVerboseValue: boolean): string {
  return isVerboseValue ? 'details:' : 'files:';
}

function formatVerboseDetailSection(options: {
  issues: readonly SourceStructuredIssue[];
  verbose: boolean;
}): string[] {
  return options.verbose ? formatVerboseDetails(options.issues) : [];
}

function formatRemainingLocations(options: {
  remainingCount: number;
  report: SourceIssueReportOptions;
}): string[] {
  if (options.remainingCount === 0) return [];
  return [
    `  ... ${options.remainingCount} more`,
    '',
    'Show all files:',
    `  ${createVerboseCommand(options.report)}`,
  ];
}

function getLocations(options: {
  config: ResolvedLiminaConfig;
  group: GenericSourceIssueGroup;
}): string[] {
  return uniqueSortedStrings(
    options.group.issues.map((issue) =>
      getGenericSourceIssueDisplayLocation(options.config.rootDir, issue),
    ),
  );
}

export function formatGenericSourceIssueGroup(options: {
  config: ResolvedLiminaConfig;
  group: GenericSourceIssueGroup;
  report: SourceIssueReportOptions;
}): string[] {
  const issue = getFirstIssue(options.group);
  if (issue === undefined) return [];
  const locations = getLocations(options);
  const isVerbose = options.report.verbose === true;
  const visibleLocations = getVisibleLocations({
    locations,
    verbose: isVerbose,
  });
  const remainingCount = locations.length - visibleLocations.length;
  return [
    `${issue.title}  ${options.group.issues.length} ${plural(
      options.group.issues.length,
      'issue',
      'issues',
    )}`,
    `package: ${issue.ownerName}`,
    `rule: ${issue.code}`,
    ...formatPackageManifest(options.config, issue),
    ...formatMetadata(issue),
    '',
    ...formatSummary(issue),
    'reason:',
    `  ${issue.reason}`,
    ...formatFixSection(issue),
    ...formatVerifySection(issue),
    ...formatEvidenceSection(issue),
    '',
    getDetailsHeading(isVerbose),
    ...visibleLocations.map((location) => `  - ${location}`),
    ...formatVerboseDetailSection({
      issues: options.group.issues,
      verbose: isVerbose,
    }),
    ...formatRemainingLocations({ remainingCount, report: options.report }),
  ];
}
