import type {
  LiminaCheckIssue,
  LiminaCheckIssueEvidence,
  LiminaCheckIssueLocation,
} from './snapshot';

function appendIfPresent(lines: string[], label: string, value: unknown): void {
  if (typeof value !== 'string' || value.length === 0) {
    return;
  }

  lines.push(`${label}: ${value}`);
}

function appendSection(
  lines: string[],
  heading: string,
  values: readonly string[] | undefined,
): void {
  if (!values?.length) {
    return;
  }

  lines.push(`${heading}:`, ...values.map((line) => `  ${line}`));
}

function appendIssueFields(lines: string[], issue: LiminaCheckIssue): void {
  const fields: readonly [label: string, value: unknown][] = [
    ['rule', issue.code],
    ['task', issue.task],
    ['domain', issue.domain],
    ['detector', issue.detector],
    ['severity', issue.severity],
    ['package', issue.packageName],
    ['package manifest', issue.packageManifestPath],
    ['checker', issue.checkerName],
    ['tool', issue.tool],
    ['file', issue.filePath],
    ['scope', issue.scope],
    ['summary', issue.summary],
    ['reason', issue.reason],
    ['suggested fix', issue.fix],
  ];

  for (const [label, value] of fields) {
    appendIfPresent(lines, label, value);
  }
}

function appendFixSteps(
  lines: string[],
  fixSteps: readonly string[] | undefined,
): void {
  if (!fixSteps?.length) {
    return;
  }

  lines.push(
    'fix steps:',
    ...fixSteps.map((step, index) => `  ${index + 1}. ${step}`),
  );
}

function firstDefinedString(values: readonly (string | undefined)[]): string {
  for (const value of values) {
    if (value !== undefined) {
      return value;
    }
  }

  return '';
}

function getLocationTarget(location: LiminaCheckIssueLocation): string {
  return firstDefinedString([
    location.filePath,
    location.packageManifestPath,
    location.scope,
  ]);
}

function formatLocationPosition(location: LiminaCheckIssueLocation): string {
  if (location.line === undefined) {
    return '';
  }

  const column = location.column === undefined ? '' : `:${location.column}`;
  return `:${location.line}${column}`;
}

function formatLocation(location: LiminaCheckIssueLocation): string {
  const label = location.label ? `${location.label}: ` : '';
  return `  - ${label}${getLocationTarget(location)}${formatLocationPosition(location)}`;
}

function appendLocations(
  lines: string[],
  locations: readonly LiminaCheckIssueLocation[] | undefined,
): void {
  if (!locations?.length) {
    return;
  }

  lines.push('locations:', ...locations.map(formatLocation));
}

function formatEvidenceHeading(evidence: LiminaCheckIssueEvidence): string {
  return [evidence.label, evidence.value].filter(Boolean).join(': ');
}

function appendEvidenceHeading(
  lines: string[],
  evidence: LiminaCheckIssueEvidence,
): void {
  const heading = formatEvidenceHeading(evidence);
  if (heading) {
    lines.push(`  - ${heading}`);
  }
}

function appendEvidenceLines(
  lines: string[],
  evidenceLines: readonly string[] | undefined,
): void {
  if (!evidenceLines?.length) {
    return;
  }

  lines.push(...evidenceLines.map((line) => `    ${line}`));
}

function appendEvidenceEntry(
  lines: string[],
  evidence: LiminaCheckIssueEvidence,
): void {
  appendEvidenceHeading(lines, evidence);
  appendEvidenceLines(lines, evidence.lines);
}

function hasItems<Value>(
  values: readonly Value[] | undefined,
): values is readonly Value[] {
  return values !== undefined && values.length > 0;
}

function appendEvidence(
  lines: string[],
  evidence: readonly LiminaCheckIssueEvidence[] | undefined,
): void {
  if (!hasItems(evidence)) {
    return;
  }

  lines.push('evidence:');
  for (const entry of evidence) {
    appendEvidenceEntry(lines, entry);
  }
}

function appendExternalIssue(lines: string[], issue: LiminaCheckIssue): void {
  if (!issue.external) {
    return;
  }

  lines.push('external:');
  appendIfPresent(lines, '  tool', issue.external.tool);
  appendIfPresent(lines, '  code', issue.external.code);
  appendIfPresent(lines, '  message', issue.external.message);
  appendIfPresent(lines, '  url', issue.external.url);
}

function formatIssueForErrorMessage(
  issue: LiminaCheckIssue,
  index: number,
): string[] {
  const lines = [`issue ${index + 1}: ${issue.title}`];

  appendIssueFields(lines, issue);
  appendFixSteps(lines, issue.fixSteps);
  appendLocations(lines, issue.locations);
  appendEvidence(lines, issue.evidence);
  appendExternalIssue(lines, issue);
  appendSection(lines, 'details', issue.detailLines);
  appendSection(lines, 'verify', issue.verifyCommands);

  return lines;
}

function formatIssueBlock(issue: LiminaCheckIssue, index: number): string[] {
  const separator = index === 0 ? [] : [''];
  return [...separator, ...formatIssueForErrorMessage(issue, index)];
}

function formatStructuredErrorMessage(
  message: string,
  issues: readonly LiminaCheckIssue[],
): string {
  if (issues.length === 0) {
    return message;
  }

  return [message, '', ...issues.flatMap(formatIssueBlock)].join('\n');
}

export class LiminaStructuredError extends Error {
  override readonly name = 'LiminaStructuredError';
  readonly issues: LiminaCheckIssue[];

  constructor(message: string, issues: readonly LiminaCheckIssue[]) {
    super(formatStructuredErrorMessage(message, issues));
    this.issues = [...issues];
  }
}
