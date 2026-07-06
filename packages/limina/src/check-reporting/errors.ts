import type { LiminaCheckIssue } from './snapshot';

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

function formatIssueForErrorMessage(
  issue: LiminaCheckIssue,
  index: number,
): string[] {
  const lines = [`issue ${index + 1}: ${issue.title}`];

  appendIfPresent(lines, 'rule', issue.code);
  appendIfPresent(lines, 'task', issue.task);
  appendIfPresent(lines, 'domain', issue.domain);
  appendIfPresent(lines, 'detector', issue.detector);
  appendIfPresent(lines, 'severity', issue.severity);
  appendIfPresent(lines, 'package', issue.packageName);
  appendIfPresent(lines, 'package manifest', issue.packageManifestPath);
  appendIfPresent(lines, 'checker', issue.checkerName);
  appendIfPresent(lines, 'tool', issue.tool);
  appendIfPresent(lines, 'file', issue.filePath);
  appendIfPresent(lines, 'scope', issue.scope);
  appendIfPresent(lines, 'summary', issue.summary);
  appendIfPresent(lines, 'reason', issue.reason);
  appendIfPresent(lines, 'suggested fix', issue.fix);

  if (issue.fixSteps?.length) {
    lines.push(
      'fix steps:',
      ...issue.fixSteps.map((step, stepIndex) => `  ${stepIndex + 1}. ${step}`),
    );
  }

  if (issue.locations?.length) {
    lines.push(
      'locations:',
      ...issue.locations.map((location) => {
        const locationTarget =
          location.filePath ??
          location.packageManifestPath ??
          location.scope ??
          '';
        const position =
          location.line === undefined
            ? ''
            : `:${location.line}${location.column === undefined ? '' : `:${location.column}`}`;
        const label = location.label ? `${location.label}: ` : '';

        return `  - ${label}${locationTarget}${position}`;
      }),
    );
  }

  if (issue.evidence?.length) {
    lines.push('evidence:');

    for (const evidence of issue.evidence) {
      const heading = [evidence.label, evidence.value]
        .filter(Boolean)
        .join(': ');

      if (heading) {
        lines.push(`  - ${heading}`);
      }

      if (evidence.lines?.length) {
        lines.push(...evidence.lines.map((line) => `    ${line}`));
      }
    }
  }

  if (issue.external) {
    lines.push('external:');
    appendIfPresent(lines, '  tool', issue.external.tool);
    appendIfPresent(lines, '  code', issue.external.code);
    appendIfPresent(lines, '  message', issue.external.message);
    appendIfPresent(lines, '  url', issue.external.url);
  }

  appendSection(lines, 'details', issue.detailLines);
  appendSection(lines, 'verify', issue.verifyCommands);

  return lines;
}

function formatStructuredErrorMessage(
  message: string,
  issues: readonly LiminaCheckIssue[],
): string {
  if (issues.length === 0) {
    return message;
  }

  return [
    message,
    '',
    ...issues.flatMap((issue, index) => [
      ...(index === 0 ? [] : ['']),
      ...formatIssueForErrorMessage(issue, index),
    ]),
  ].join('\n');
}

export class LiminaStructuredError extends Error {
  override readonly name = 'LiminaStructuredError';
  readonly issues: LiminaCheckIssue[];

  constructor(message: string, issues: readonly LiminaCheckIssue[]) {
    super(formatStructuredErrorMessage(message, issues));
    this.issues = [...issues];
  }
}
