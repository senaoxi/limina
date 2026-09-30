import { LIMINA_CHECK_ISSUE_CODES } from '../codes';
import type {
  LiminaCheckIssue,
  LiminaCheckIssueEvidence,
  LiminaCheckIssueExternal,
} from '../snapshot';

export function indentDetailLines(lines: readonly string[]): string[] {
  return lines.map((line) => (line.length > 0 ? `    ${line}` : ''));
}

export function formatEvidenceLine(
  evidence: LiminaCheckIssueEvidence,
): string[] {
  const heading = [evidence.label, evidence.value].filter(Boolean).join(': ');
  const lines = (evidence.lines ?? []).map((line) => `    ${line}`);
  return heading.length > 0 ? [`  - ${heading}`, ...lines] : lines;
}

function isLinesEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((line, index) => line === right[index])
  );
}

function hasMatchingEvidenceLines(
  evidence: readonly LiminaCheckIssueEvidence[] | undefined,
  detailLines: readonly string[],
): boolean {
  if (evidence === undefined) return false;
  return evidence.some((item) => {
    return item.lines !== undefined && isLinesEqual(item.lines, detailLines);
  });
}

export function isStructuredGraphPrepareIssue(
  issue: LiminaCheckIssue,
): boolean {
  return issue.task === 'graph:prepare' && issue.detector === 'graph-prepare';
}

function shouldHideEvidence(issue: LiminaCheckIssue): boolean {
  return issue.task === 'graph:check'
    ? issue.code !== LIMINA_CHECK_ISSUE_CODES.graphCheckFailed
    : issue.task === 'proof:check' &&
        issue.code !== LIMINA_CHECK_ISSUE_CODES.proofCheckFailed;
}

function getVisibleEvidence(
  issue: LiminaCheckIssue,
): readonly LiminaCheckIssueEvidence[] | undefined {
  return shouldHideEvidence(issue) ? undefined : issue.evidence;
}

function hasDetailLines(
  lines: readonly string[] | undefined,
): lines is readonly string[] {
  return lines !== undefined && lines.length > 0;
}

function hasVisibleRawDetails(options: {
  detailLines: readonly string[] | undefined;
  includeDetailLines: boolean;
  visibleEvidence: readonly LiminaCheckIssueEvidence[] | undefined;
}): options is {
  detailLines: readonly string[];
  includeDetailLines: true;
  visibleEvidence: readonly LiminaCheckIssueEvidence[] | undefined;
} {
  return (
    options.includeDetailLines &&
    hasDetailLines(options.detailLines) &&
    !hasMatchingEvidenceLines(options.visibleEvidence, options.detailLines)
  );
}

function getVisibleRawDetails(options: {
  includeDetailLines: boolean;
  issue: LiminaCheckIssue;
  visibleEvidence: readonly LiminaCheckIssueEvidence[] | undefined;
}): string[] {
  const candidate = {
    detailLines: options.issue.detailLines,
    includeDetailLines: options.includeDetailLines,
    visibleEvidence: options.visibleEvidence,
  };
  return hasVisibleRawDetails(candidate)
    ? indentDetailLines(candidate.detailLines)
    : [];
}

function getSummaryLines(
  issue: LiminaCheckIssue,
  isIncludeSummaryValue: boolean,
): string[] {
  if (!isIncludeSummaryValue) return [];
  return issue.summary === undefined
    ? []
    : ['summary:', `    ${issue.summary}`];
}

function getEvidenceLines(
  evidence: readonly LiminaCheckIssueEvidence[] | undefined,
): string[] {
  return evidence === undefined || evidence.length === 0
    ? []
    : ['evidence:', ...evidence.flatMap(formatEvidenceLine)];
}

function isDefaultTrue(value: boolean | undefined): boolean {
  return value === undefined || value;
}

export function formatIssueDetailLines(
  issue: LiminaCheckIssue,
  options: { includeDetailLines?: boolean; includeSummary?: boolean } = {},
): string[] {
  const isIncludeDetailLines = isDefaultTrue(options.includeDetailLines);
  const isIncludeSummary = isDefaultTrue(options.includeSummary);
  const visibleEvidence = getVisibleEvidence(issue);
  return [
    ...getSummaryLines(issue, isIncludeSummary),
    ...getEvidenceLines(visibleEvidence),
    ...getVisibleRawDetails({
      includeDetailLines: isIncludeDetailLines,
      issue,
      visibleEvidence,
    }),
  ];
}

function appendExternalField(
  lines: string[],
  label: string,
  value: string | undefined,
): void {
  if (value !== undefined) lines.push(`  ${label}: ${value}`);
}

export function formatExternalLines(
  external: LiminaCheckIssueExternal | undefined,
): string[] {
  if (external === undefined) return [];
  const lines = ['external:'];
  appendExternalField(lines, 'tool', external.tool);
  appendExternalField(lines, 'code', external.code);
  appendExternalField(lines, 'message', external.message);
  appendExternalField(lines, 'url', external.url);
  return lines;
}
