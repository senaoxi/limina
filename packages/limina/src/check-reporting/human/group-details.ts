import { plural } from '#utils/reporting';
import type { LiminaCheckIssue } from '../snapshot';
import {
  getGroupLocations,
  getGroupLocationsHeading,
  getIssueLocation,
} from './groups';
import {
  formatExternalLines,
  formatIssueDetailLines,
  isStructuredGraphPrepareIssue,
} from './issue-details';
import { appendOptionalField, appendOptionalSection } from './lines';
import type { IssueGroup } from './types';

function formatFixSteps(steps: readonly string[]): string[] {
  return [
    'fix steps:',
    ...steps.map((step, index) => `  ${index + 1}. ${step}`),
  ];
}

function formatSuggestedFix(fix: string | undefined): string[] {
  return fix === undefined ? [] : ['suggested fix:', `  ${fix}`];
}

function formatFixLines(group: IssueGroup): string[] {
  if (group.fixSteps !== undefined && group.fixSteps.length > 0) {
    return formatFixSteps(group.fixSteps);
  }
  return formatSuggestedFix(group.fix);
}

type GraphPrepareExample = NonNullable<LiminaCheckIssue['evidence']>[number] & {
  lines: string[];
};

function isGraphPrepareExample(
  evidence: NonNullable<LiminaCheckIssue['evidence']>[number],
): evidence is GraphPrepareExample {
  if (evidence.label !== 'example') return false;
  if (evidence.lines === undefined) return false;
  return evidence.lines.length > 0;
}

function getExampleEvidenceLines(issue: LiminaCheckIssue): string[] | null {
  const evidence = issue.evidence ?? [];
  const example = evidence.find(isGraphPrepareExample);
  return example === undefined ? null : [...example.lines];
}

function getLocationExampleLines(issue: LiminaCheckIssue): string[] {
  const location = getIssueLocation(issue);
  return location.length === 0 ? [] : [`location: ${location}`];
}

function getGraphPrepareExampleLines(issue: LiminaCheckIssue): string[] {
  return getExampleEvidenceLines(issue) ?? getLocationExampleLines(issue);
}

function formatExampleLines(lines: readonly string[]): string[] {
  const [firstLine, ...restLines] = lines;
  return [`  - ${firstLine ?? ''}`, ...restLines.map((line) => `    ${line}`)];
}

function formatExampleOverflow(count: number): string[] {
  if (count === 0) return [];
  return [`  ... ${count} more. Run with --verbose to show all details.`];
}

function formatGraphPrepareExamples(
  examples: readonly string[][],
  detailLimit: number,
): string[] | null {
  if (examples.length <= 1) return null;
  const visibleExamples = examples.slice(0, detailLimit);
  const remaining = examples.length - visibleExamples.length;
  return [
    'examples:',
    ...visibleExamples.flatMap(formatExampleLines),
    ...formatExampleOverflow(remaining),
  ];
}

function formatGraphPrepareGroupExamples(
  group: IssueGroup,
  detailLimit: number,
): string[] | null {
  if (!group.issues.every(isStructuredGraphPrepareIssue)) return null;
  const examples = group.issues
    .map(getGraphPrepareExampleLines)
    .filter((lines) => lines.length > 0);
  return formatGraphPrepareExamples(examples, detailLimit);
}

function formatVerboseIssueDetails(
  issue: LiminaCheckIssue,
  index: number,
): string[] {
  return [
    ...(index === 0 ? [] : ['']),
    `  - ${getIssueLocation(issue)}`,
    ...formatIssueDetailLines(issue).map((line) =>
      line.length > 0 ? `    ${line}` : '',
    ),
  ];
}

function formatVerboseGroupDetails(group: IssueGroup): string[] {
  return ['details:', ...group.issues.flatMap(formatVerboseIssueDetails)];
}

function formatVisibleLocations(options: {
  group: IssueGroup;
  locations: readonly string[];
  limit: number;
}): string[] {
  const visibleLocations = options.locations.slice(0, options.limit);
  const remaining = options.locations.length - visibleLocations.length;
  const lines = [
    getGroupLocationsHeading(options.group),
    ...visibleLocations.map((location) => `  - ${location}`),
  ];
  if (remaining > 0) lines.push(`  ... ${remaining} more`);
  return lines;
}

function getSingleIssueDetails(group: IssueGroup): string[] {
  if (group.issues.length !== 1) return [];
  const issue = group.issues[0]!;
  const structuredPrepare = isStructuredGraphPrepareIssue(issue);
  return formatIssueDetailLines(issue, {
    includeDetailLines: !structuredPrepare,
    includeSummary: !structuredPrepare,
  });
}

function formatLimitedDetails(
  lines: readonly string[],
  detailLimit: number,
): string[] {
  const visibleLines = lines.slice(0, detailLimit);
  const remaining = lines.length - visibleLines.length;
  const result = ['details:', ...visibleLines.map((line) => `  ${line}`)];
  if (remaining > 0) result.push(`  ... ${remaining} more`);
  return result;
}

function getMultiLocationDetails(
  group: IssueGroup,
  detailLimit: number,
): string[] | null {
  const locations = getGroupLocations(group);
  const hasMultipleIssueLocations =
    locations.length > 0 && group.issues.length > 1;
  if (!hasMultipleIssueLocations) return null;
  return formatVisibleLocations({ group, limit: detailLimit, locations });
}

function getSingleIssueDetailBlock(
  group: IssueGroup,
  detailLimit: number,
): string[] | null {
  const issueDetails = getSingleIssueDetails(group);
  if (issueDetails.length === 0) return null;
  return formatLimitedDetails(issueDetails, detailLimit);
}

function formatFallbackLocations(
  group: IssueGroup,
  detailLimit: number,
): string[] {
  return formatVisibleLocations({
    group,
    limit: detailLimit,
    locations: getGroupLocations(group),
  });
}

function formatNonVerboseGroupDetails(
  group: IssueGroup,
  detailLimit: number,
): string[] {
  const candidates = [
    formatGraphPrepareGroupExamples(group, detailLimit),
    getMultiLocationDetails(group, detailLimit),
    getSingleIssueDetailBlock(group, detailLimit),
  ];
  return (
    candidates.find((candidate) => candidate !== null) ??
    formatFallbackLocations(group, detailLimit)
  );
}

export function formatGroupDetails(
  group: IssueGroup,
  options: { detailLimit: number; verbose: boolean },
): string[] {
  if (options.verbose) return formatVerboseGroupDetails(group);
  return formatNonVerboseGroupDetails(group, options.detailLimit);
}

function appendSummary(lines: string[], summary: string | undefined): void {
  if (summary !== undefined) lines.push('', 'summary:', `  ${summary}`);
}

function appendVerifyCommands(
  lines: string[],
  commands: readonly string[] | undefined,
): void {
  if (commands === undefined || commands.length === 0) return;
  lines.push('', 'verify:', ...commands.map((command) => `  - ${command}`));
}

export function formatIssueGroup(
  group: IssueGroup,
  options: { detailLimit: number; verbose: boolean },
): string[] {
  const lines = [
    `${group.title}  ${group.issues.length} ${plural(
      group.issues.length,
      'issue',
      'issues',
    )}`,
    `rule: ${group.code}`,
    `task: ${group.task}`,
  ];
  appendOptionalField(lines, 'domain', group.domain);
  appendOptionalField(lines, 'detector', group.detector);
  appendOptionalField(lines, 'severity', group.severity);
  appendOptionalField(lines, 'package', group.packageName);
  appendOptionalField(lines, 'package manifest', group.packageManifestPath);
  appendOptionalField(lines, 'checker', group.checkerName);
  appendOptionalField(lines, 'tool', group.tool);
  lines.push(...formatExternalLines(group.external));
  appendSummary(lines, group.summary);
  lines.push('', 'reason:', `  ${group.reason}`);
  appendOptionalSection(lines, formatFixLines(group));
  appendVerifyCommands(lines, group.verifyCommands);
  lines.push('', ...formatGroupDetails(group, options));
  return lines;
}
