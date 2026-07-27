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

function linesEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((line, index) => line === right[index]);
}

function hasMatchingEvidenceLines(
  evidence: readonly LiminaCheckIssueEvidence[] | undefined,
  detailLines: readonly string[],
): boolean {
  if (evidence === undefined) return false;
  return evidence.some((item) => {
    if (item.lines === undefined) return false;
    return linesEqual(item.lines, detailLines);
  });
}

export function isStructuredGraphPrepareIssue(
  issue: LiminaCheckIssue,
): boolean {
  if (issue.task !== 'graph:prepare') return false;
  return issue.detector === 'graph-prepare';
}

function shouldHideEvidence(issue: LiminaCheckIssue): boolean {
  if (issue.task === 'graph:check') {
    return issue.code !== LIMINA_CHECK_ISSUE_CODES.graphCheckFailed;
  }
  if (issue.task === 'proof:check') {
    return issue.code !== LIMINA_CHECK_ISSUE_CODES.proofCheckFailed;
  }
  return false;
}

function getVisibleEvidence(
  issue: LiminaCheckIssue,
): readonly LiminaCheckIssueEvidence[] | undefined {
  return shouldHideEvidence(issue) ? undefined : issue.evidence;
}

function hasDetailLines(
  lines: readonly string[] | undefined,
): lines is readonly string[] {
  if (lines === undefined) return false;
  return lines.length > 0;
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
  if (!options.includeDetailLines) return false;
  if (!hasDetailLines(options.detailLines)) return false;
  return !hasMatchingEvidenceLines(
    options.visibleEvidence,
    options.detailLines,
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
  includeSummary: boolean,
): string[] {
  if (!includeSummary) return [];
  if (issue.summary === undefined) return [];
  return ['summary:', `    ${issue.summary}`];
}

function getEvidenceLines(
  evidence: readonly LiminaCheckIssueEvidence[] | undefined,
): string[] {
  if (evidence === undefined || evidence.length === 0) return [];
  return ['evidence:', ...evidence.flatMap(formatEvidenceLine)];
}

function defaultTrue(value: boolean | undefined): boolean {
  return value === undefined ? true : value;
}

export function formatIssueDetailLines(
  issue: LiminaCheckIssue,
  options: { includeDetailLines?: boolean; includeSummary?: boolean } = {},
): string[] {
  const includeDetailLines = defaultTrue(options.includeDetailLines);
  const includeSummary = defaultTrue(options.includeSummary);
  const visibleEvidence = getVisibleEvidence(issue);
  return [
    ...getSummaryLines(issue, includeSummary),
    ...getEvidenceLines(visibleEvidence),
    ...getVisibleRawDetails({
      includeDetailLines,
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
