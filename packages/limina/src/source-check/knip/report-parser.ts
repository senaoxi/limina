import type { JSONReport } from 'knip';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertKnipJsonReport(value: unknown): JSONReport {
  if (!isRecord(value)) {
    throw new TypeError('JSON report must be an object with an issues array.');
  }

  if (!Array.isArray(value.issues)) {
    throw new TypeError('JSON report must be an object with an issues array.');
  }

  return value as unknown as JSONReport;
}

function tryParseKnipJsonReport(source: string): JSONReport | undefined {
  try {
    return assertKnipJsonReport(JSON.parse(source) as unknown);
  } catch {
    return undefined;
  }
}

function getMatchStart(match: RegExpMatchArray): number {
  return match.index === undefined ? 0 : match.index;
}

function findReportFromStart(
  source: string,
  start: number,
): JSONReport | undefined {
  let end = source.indexOf('}', start) + 1;

  while (end > start) {
    const report = tryParseKnipJsonReport(source.slice(start, end));
    if (report !== undefined) {
      return report;
    }
    end = source.indexOf('}', end) + 1;
  }

  return undefined;
}

function findEmbeddedReport(source: string): JSONReport | undefined {
  const reportStartPattern = /\{\s*"issues"\s*:/gu;

  for (const match of source.matchAll(reportStartPattern)) {
    const report = findReportFromStart(source, getMatchStart(match));
    if (report !== undefined) {
      return report;
    }
  }

  return undefined;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function throwKnipParseError(source: string): never {
  try {
    return assertKnipJsonReport(JSON.parse(source) as unknown) as never;
  } catch (error) {
    throw new Error(
      [
        'Failed to parse Knip JSON report.',
        "  reason: Limina expects Knip's json reporter to write a JSON object with an issues array.",
        `  error: ${getErrorMessage(error)}`,
        '  output:',
        source.slice(0, 2000),
      ].join('\n'),
    );
  }
}

function parseNonEmptyReport(source: string): JSONReport {
  const direct = tryParseKnipJsonReport(source);
  if (direct !== undefined) {
    return direct;
  }

  const embedded = findEmbeddedReport(source);
  if (embedded !== undefined) {
    return embedded;
  }

  return throwKnipParseError(source);
}

export function parseKnipJsonReport(source: string): JSONReport {
  const trimmed = source.trim();
  if (trimmed.length === 0) {
    return { issues: [] };
  }

  return parseNonEmptyReport(trimmed);
}
