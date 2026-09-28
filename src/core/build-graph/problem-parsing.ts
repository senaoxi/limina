import type {
  LiminaCheckIssueEvidence,
  LiminaCheckIssueLocation,
} from '../../check-reporting/snapshot';

function getLineLabelValue(
  line: string,
  labels: readonly string[],
): string | undefined {
  const trimmedLine = line.trimStart();
  const label = labels.find((candidate) =>
    trimmedLine.startsWith(`${candidate}:`),
  );
  if (!label) {
    return undefined;
  }

  const value = trimmedLine.slice(label.length + 1).trim();
  return value.length > 0 ? value : undefined;
}

export function findGeneratedGraphProblemLineValue(
  lines: readonly string[],
  labels: readonly string[],
): string | undefined {
  for (const line of lines) {
    const value = getLineLabelValue(line, labels);
    if (value) {
      return value;
    }
  }

  return undefined;
}

export function getGeneratedGraphProblemTitle(
  lines: readonly string[],
): string {
  const title = lines[0]?.replace(/:+$/u, '');
  return title || 'Generated graph preparation failed';
}

function isProblemSectionHeader(line: string): boolean {
  return /^ {2}[A-Za-z][A-Za-z ]*:/u.test(line);
}

function appendProblemBlockLine(output: string[], line: string): void {
  if (line.trim()) {
    output.push(line.replace(/^ {4}/u, '').trimEnd());
  }
}

function collectProblemBlockFromIndex(
  lines: readonly string[],
  startIndex: number,
): string[] {
  const blockLines: string[] = [];
  for (const line of lines.slice(startIndex + 1)) {
    if (isProblemSectionHeader(line)) {
      break;
    }
    appendProblemBlockLine(blockLines, line);
  }
  return blockLines;
}

export function collectGeneratedGraphProblemBlockLines(
  lines: readonly string[],
  label: string,
): string[] {
  const startIndex = lines.findIndex(
    (line) => line.trimStart() === `${label}:`,
  );
  if (startIndex === -1) {
    return [];
  }
  return collectProblemBlockFromIndex(lines, startIndex);
}

function hasEvidenceLines(evidence: LiminaCheckIssueEvidence): boolean {
  const lines = evidence.lines;
  return Array.isArray(lines) && lines.length > 0;
}

export function isNonEmptyGeneratedGraphEvidence(
  evidence: LiminaCheckIssueEvidence | undefined,
): evidence is LiminaCheckIssueEvidence {
  if (!evidence) {
    return false;
  }
  return Boolean(evidence.value) || hasEvidenceLines(evidence);
}

export function isNonEmptyGeneratedGraphLocation(
  location: LiminaCheckIssueLocation | undefined,
): location is LiminaCheckIssueLocation {
  if (!location) {
    return false;
  }
  return [location.filePath, location.packageManifestPath, location.scope].some(
    Boolean,
  );
}

function getGeneratedGraphProblemLine(
  lines: readonly string[],
  label: string,
): string | undefined {
  const value = findGeneratedGraphProblemLineValue(lines, [label]);
  return value ? `${label}: ${value}` : undefined;
}

export function createImportExampleEvidence(
  lines: readonly string[],
  extraLabels: readonly string[] = [],
): LiminaCheckIssueEvidence | undefined {
  const exampleLines = ['file', 'imported specifier', 'resolved file']
    .concat([...extraLabels])
    .map((label) => getGeneratedGraphProblemLine(lines, label))
    .filter((line): line is string => Boolean(line));
  return exampleLines.length > 0
    ? { label: 'example', lines: exampleLines }
    : undefined;
}

function trimCheckerDescriptor(descriptor: string): string {
  const openParenthesisIndex = descriptor.indexOf('(');
  if (openParenthesisIndex <= 0) {
    return descriptor;
  }
  const descriptorPrefix = descriptor.slice(0, openParenthesisIndex);
  const checkerName = descriptorPrefix.trimEnd();
  return descriptorPrefix.endsWith(' ') ? checkerName : descriptor;
}

export function getCheckerDescriptorName(
  descriptor: string | undefined,
): string {
  if (!descriptor) {
    return 'Consumer checker';
  }
  return trimCheckerDescriptor(descriptor);
}
