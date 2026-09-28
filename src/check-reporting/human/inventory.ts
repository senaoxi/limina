import { getAllCanonicalIssueLocations } from '../inventory-presentation';
import type { LiminaCheckIssue } from '../snapshot';
import { formatIssueBlock } from './block';
import { formatEvidenceLine, formatExternalLines } from './issue-details';
import type { CheckIssueInventoryCardOptions } from './types';

function collapseIssueScalar(value: string): string {
  return value.split(/\s+/u).filter(Boolean).join(' ');
}

function appendScalarField(
  lines: string[],
  label: string,
  value: string | undefined,
): void {
  if (value !== undefined && value.length > 0) {
    lines.push(`${label}: ${value}`);
  }
}

function getLocationSummary(value: string | undefined): string {
  return value === undefined ? '(not recorded)' : value;
}

function getIssueTool(issue: LiminaCheckIssue): string | undefined {
  if (issue.tool !== undefined) return issue.tool;
  return issue.external?.tool;
}

function getCompactReason(issue: LiminaCheckIssue): {
  label: 'reason' | 'summary';
  value: string;
} {
  if (issue.summary !== undefined && issue.summary.length > 0) {
    return { label: 'summary', value: collapseIssueScalar(issue.summary) };
  }
  return { label: 'reason', value: collapseIssueScalar(issue.reason) };
}

function getCompactFix(issue: LiminaCheckIssue): string | undefined {
  if (issue.fix === undefined) return undefined;
  return collapseIssueScalar(issue.fix);
}

function formatCompactInventoryIssueLines(
  issue: LiminaCheckIssue,
  representativeLocation: string | undefined,
): string[] {
  const lines = [
    collapseIssueScalar(issue.title),
    `location: ${getLocationSummary(representativeLocation)}`,
    `rule: ${issue.code}`,
  ];
  appendScalarField(lines, 'package', issue.packageName);
  appendScalarField(lines, 'checker', issue.checkerName);
  appendScalarField(lines, 'tool', getIssueTool(issue));
  const reason = getCompactReason(issue);
  appendScalarField(lines, reason.label, reason.value);
  appendScalarField(lines, 'fix', getCompactFix(issue));
  return lines;
}

function getDeduplicatedRawDetailLines(issue: LiminaCheckIssue): string[] {
  const evidenceLines = new Set(
    (issue.evidence ?? []).flatMap((evidence) => evidence.lines ?? []),
  );
  const seen = new Set<string>();
  return (issue.detailLines ?? []).filter((line) => {
    if (evidenceLines.has(line)) return false;
    if (seen.has(line)) return false;
    seen.add(line);
    return true;
  });
}

function appendOptionalSection(
  lines: string[],
  heading: string,
  sectionLines: readonly string[],
): void {
  if (sectionLines.length === 0) return;
  lines.push('', heading, ...sectionLines);
}

function formatNumberedSteps(steps: readonly string[] | undefined): string[] {
  if (steps === undefined) return [];
  return steps.map((step, index) => `  ${index + 1}. ${step}`);
}

function formatCommands(commands: readonly string[] | undefined): string[] {
  if (commands === undefined) return [];
  return commands.map((command) => `  - ${command}`);
}

function formatLocations(issue: LiminaCheckIssue): string[] {
  const locations = getAllCanonicalIssueLocations(issue);
  if (locations.length === 0) return ['  - (not recorded)'];
  return locations.map((location) => `  - ${location}`);
}

function appendMetadata(lines: string[], issue: LiminaCheckIssue): void {
  appendScalarField(lines, 'domain', issue.domain);
  appendScalarField(lines, 'detector', issue.detector);
  appendScalarField(lines, 'severity', issue.severity);
  appendScalarField(lines, 'package', issue.packageName);
  appendScalarField(lines, 'package manifest', issue.packageManifestPath);
  appendScalarField(lines, 'checker', issue.checkerName);
  appendScalarField(lines, 'tool', getIssueTool(issue));
}

function formatSummarySection(issue: LiminaCheckIssue): string[] {
  return issue.summary === undefined ? [] : [`  ${issue.summary}`];
}

function formatFixSection(issue: LiminaCheckIssue): string[] {
  return issue.fix === undefined ? [] : [`  ${issue.fix}`];
}

function formatEvidenceSection(issue: LiminaCheckIssue): string[] {
  if (issue.evidence === undefined) return [];
  return issue.evidence.flatMap(formatEvidenceLine);
}

function formatDetailedInventoryIssueLines(issue: LiminaCheckIssue): string[] {
  const lines = [issue.title, `rule: ${issue.code}`, `task: ${issue.task}`];
  appendMetadata(lines, issue);
  lines.push(...formatExternalLines(issue.external));
  appendOptionalSection(lines, 'locations:', formatLocations(issue));
  appendOptionalSection(lines, 'summary:', formatSummarySection(issue));
  appendOptionalSection(lines, 'reason:', [`  ${issue.reason}`]);
  appendOptionalSection(lines, 'suggested fix:', formatFixSection(issue));
  appendOptionalSection(
    lines,
    'fix steps:',
    formatNumberedSteps(issue.fixSteps),
  );
  appendOptionalSection(lines, 'verify:', formatCommands(issue.verifyCommands));
  appendOptionalSection(lines, 'evidence:', formatEvidenceSection(issue));
  appendOptionalSection(
    lines,
    'details:',
    getDeduplicatedRawDetailLines(issue).map((line) => `  ${line}`),
  );
  return lines;
}

export function formatCheckIssueInventoryCard(
  options: CheckIssueInventoryCardOptions,
): string {
  const lines =
    options.view === 'compact'
      ? formatCompactInventoryIssueLines(
          options.issue,
          options.representativeLocation,
        )
      : formatDetailedInventoryIssueLines(options.issue);
  return formatIssueBlock(lines, {
    color: options.color,
    severity: options.issue.severity,
  }).join('\n');
}
