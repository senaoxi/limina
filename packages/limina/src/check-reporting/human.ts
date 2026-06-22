import boxen from 'boxen';

import { uniqueSortedStrings } from '#utils/collections';
import { formatCheckSummaryBlock } from '../reporting';
import type {
  LiminaCheckIssue,
  LiminaCheckIssueEvidence,
  LiminaCheckIssueExternal,
  LiminaCheckIssueLocation,
} from './snapshot';

const DEFAULT_DETAIL_LIMIT = 5;
const ISSUE_BLOCK_MIN_WIDTH = 88;
const ISSUE_BLOCK_HORIZONTAL_PADDING = 2;
const ISSUE_BLOCK_BORDER_WIDTH = 2;
const ANSI_RESET = '\u001B[0m';
const ANSI_BLUE = '\u001B[34m';
const ANSI_CYAN = '\u001B[36m';
const ANSI_GREEN = '\u001B[32m';
const ANSI_MAGENTA = '\u001B[35m';
const ANSI_RED = '\u001B[31m';
const ANSI_YELLOW = '\u001B[33m';
const LABEL_PREFIX_PATTERN = /^(\s*(?:-\s+|\d+\.\s+)?)([A-Za-z][A-Za-z ]*):/u;

type AnsiColor = string;

export interface CheckIssueReportOptions {
  command?: string;
  defer?: boolean;
  verbose?: boolean;
}

export interface CheckIssueHumanReportOptions extends CheckIssueReportOptions {
  detailLimit?: number;
  issues: readonly LiminaCheckIssue[];
  title: string;
}

interface IssueGroup {
  checkerName?: string;
  code: string;
  detector?: string;
  domain?: string;
  external?: LiminaCheckIssueExternal;
  fix?: string;
  fixSteps?: string[];
  issues: LiminaCheckIssue[];
  packageManifestPath?: string;
  packageName?: string;
  reason: string;
  severity?: string;
  summary?: string;
  task: string;
  title: string;
  tool?: string;
  verifyCommands?: string[];
}

function plural(count: number, singular: string, pluralForm: string): string {
  return count === 1 ? singular : pluralForm;
}

function colorText(color: AnsiColor, text: string): string {
  return `${color}${text}${ANSI_RESET}`;
}

function getSeverityColor(severity: string | undefined): AnsiColor {
  if (severity === 'warning') {
    return ANSI_YELLOW;
  }

  if (severity === 'info') {
    return ANSI_CYAN;
  }

  return ANSI_RED;
}

function getLabelColor(label: string): AnsiColor {
  switch (label.toLowerCase()) {
    case 'fix':
    case 'fix steps':
    case 'suggested fix': {
      return ANSI_GREEN;
    }
    case 'reason': {
      return ANSI_YELLOW;
    }
    case 'evidence':
    case 'external':
    case 'details': {
      return ANSI_MAGENTA;
    }
    case 'rule':
    case 'task': {
      return ANSI_BLUE;
    }
    default: {
      return ANSI_CYAN;
    }
  }
}

function countBy(
  issues: readonly LiminaCheckIssue[],
  getValue: (issue: LiminaCheckIssue) => string | undefined,
): Map<string, number> {
  const counts = new Map<string, number>();

  for (const issue of issues) {
    const value = getValue(issue);

    if (!value) {
      continue;
    }

    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  return counts;
}

function formatTopCounts(counts: Map<string, number>, limit: number): string {
  return [...counts.entries()]
    .sort(
      ([leftValue, leftCount], [rightValue, rightCount]) =>
        rightCount - leftCount || leftValue.localeCompare(rightValue),
    )
    .slice(0, limit)
    .map(([value, count]) => `${value} (${count})`)
    .join(', ');
}

function uniqueCount(
  issues: readonly LiminaCheckIssue[],
  getValue: (issue: LiminaCheckIssue) => string | undefined,
): number {
  return new Set(issues.map(getValue).filter(Boolean)).size;
}

function createVerboseCommand(command: string | undefined): string | null {
  if (!command) {
    return null;
  }

  return command.split(/\s+/u).includes('--verbose')
    ? command
    : `${command} --verbose`;
}

function getGroupKey(issue: LiminaCheckIssue): string {
  return [
    issue.task,
    issue.code,
    issue.title,
    issue.summary ?? '',
    issue.packageName ?? '',
    issue.packageManifestPath ?? '',
    issue.checkerName ?? '',
    issue.tool ?? '',
    issue.domain ?? '',
    issue.detector ?? '',
    JSON.stringify(issue.external ?? null),
    issue.reason,
    issue.fix ?? '',
    JSON.stringify(issue.fixSteps ?? null),
    JSON.stringify(issue.verifyCommands ?? null),
  ].join('\0');
}

function groupIssues(issues: readonly LiminaCheckIssue[]): IssueGroup[] {
  const groups = new Map<string, IssueGroup>();

  for (const issue of issues) {
    const key = getGroupKey(issue);
    const group = groups.get(key) ?? {
      checkerName: issue.checkerName,
      code: issue.code,
      detector: issue.detector,
      domain: issue.domain,
      external: issue.external,
      fix: issue.fix,
      fixSteps: issue.fixSteps,
      issues: [],
      packageManifestPath: issue.packageManifestPath,
      packageName: issue.packageName,
      reason: issue.reason,
      severity: issue.severity,
      summary: issue.summary,
      task: issue.task,
      title: issue.title,
      tool: issue.tool,
      verifyCommands: issue.verifyCommands,
    };

    group.issues.push(issue);
    groups.set(key, group);
  }

  return [...groups.values()].sort(
    (left, right) =>
      left.task.localeCompare(right.task) ||
      left.code.localeCompare(right.code) ||
      (left.packageName ?? '').localeCompare(right.packageName ?? '') ||
      (left.checkerName ?? '').localeCompare(right.checkerName ?? '') ||
      (left.tool ?? '').localeCompare(right.tool ?? '') ||
      left.title.localeCompare(right.title),
  );
}

function formatLocation(location: LiminaCheckIssueLocation): string {
  const filePath =
    location.filePath ??
    (location.packageManifestPath
      ? `package manifest: ${location.packageManifestPath}`
      : undefined);
  const position =
    location.line === undefined
      ? ''
      : `:${location.line}${location.column === undefined ? '' : `:${location.column}`}`;
  const locationText = filePath ? `${filePath}${position}` : location.scope;

  return [location.label, locationText].filter(Boolean).join(': ');
}

function getIssueLocations(issue: LiminaCheckIssue): string[] {
  const structuredLocations = (issue.locations ?? [])
    .map(formatLocation)
    .map((value) => value.trim())
    .filter(Boolean);

  if (structuredLocations.length > 0) {
    return structuredLocations;
  }

  return [
    issue.filePath ??
      issue.packageManifestPath ??
      issue.scope ??
      issue.checkerName ??
      issue.tool ??
      issue.title,
  ].filter((value): value is string => Boolean(value));
}

function getIssueLocation(issue: LiminaCheckIssue): string {
  return getIssueLocations(issue)[0] ?? issue.title;
}

function getGroupLocations(group: IssueGroup): string[] {
  return uniqueSortedStrings(
    group.issues
      .flatMap(getIssueLocations)
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

function getGroupLocationsHeading(group: IssueGroup): string {
  if (group.issues.some((issue) => issue.filePath)) {
    return 'files:';
  }

  if (
    group.issues.some((issue) =>
      issue.locations?.some(
        (location) => location.filePath || location.packageManifestPath,
      ),
    )
  ) {
    return 'locations:';
  }

  if (group.issues.some((issue) => issue.checkerName)) {
    return 'targets:';
  }

  return 'items:';
}

function getLineWrapPrefix(line: string): {
  content: string;
  firstPrefix: string;
  nextPrefix: string;
} {
  const labelPrefix = /^\s*(?:-\s+|\d+\.\s+)?[A-Za-z][A-Za-z ]*:\s+/u.exec(
    line,
  )?.[0];

  if (labelPrefix) {
    return {
      content: line.slice(labelPrefix.length),
      firstPrefix: labelPrefix,
      nextPrefix: ' '.repeat(labelPrefix.length),
    };
  }

  const firstPrefix = /^\s*(?:-\s+|\d+\.\s+)?/u.exec(line)?.[0] ?? '';

  return {
    content: line.slice(firstPrefix.length),
    firstPrefix,
    nextPrefix: ' '.repeat(firstPrefix.length),
  };
}

function splitLongWord(word: string, width: number): string[] {
  const chunks: string[] = [];

  if (word.includes('/')) {
    let chunk = '';
    const pathParts = word
      .split('/')
      .map((part, index, parts) =>
        index === parts.length - 1 ? part : `${part}/`,
      );

    for (const part of pathParts) {
      if (part.length > width) {
        if (chunk) {
          chunks.push(chunk);
          chunk = '';
        }

        for (let index = 0; index < part.length; index += width) {
          chunks.push(part.slice(index, index + width));
        }

        continue;
      }

      if (chunk && chunk.length + part.length > width) {
        chunks.push(chunk);
        chunk = '';
      }

      chunk = `${chunk}${part}`;
    }

    if (chunk) {
      chunks.push(chunk);
    }

    return chunks;
  }

  for (let index = 0; index < word.length; index += width) {
    chunks.push(word.slice(index, index + width));
  }

  return chunks;
}

function wrapLine(line: string, contentWidth: number): string[] {
  if (!line) {
    return [line];
  }

  const { content, firstPrefix, nextPrefix } = getLineWrapPrefix(line);
  const width = Math.max(1, contentWidth - firstPrefix.length);

  if (content.length <= width) {
    return [line];
  }

  const wrapped: string[] = [];
  let current = '';

  for (const word of content.split(/\s+/u)) {
    if (!word) {
      continue;
    }

    if (!current) {
      if (word.length > width) {
        wrapped.push(...splitLongWord(word, width));
        continue;
      }

      current = word;
      continue;
    }

    if (current.length + 1 + word.length <= width) {
      current = `${current} ${word}`;
      continue;
    }

    wrapped.push(current);
    current = '';

    if (word.length > width) {
      wrapped.push(...splitLongWord(word, width));
      continue;
    }

    current = word;
  }

  if (current) {
    wrapped.push(current);
  }

  return wrapped.map((part, index) =>
    index === 0 ? `${firstPrefix}${part}` : `${nextPrefix}${part}`,
  );
}

function getContentWidth(blockWidth: number): number {
  return Math.max(
    1,
    blockWidth - ISSUE_BLOCK_BORDER_WIDTH - ISSUE_BLOCK_HORIZONTAL_PADDING,
  );
}

function getRequiredListLineWidth(lines: readonly string[]): number {
  return lines.reduce(
    (width, line) =>
      /^\s+-\s+\S/u.test(line) ? Math.max(width, line.length) : width,
    0,
  );
}

function colorIssueTitleLine(
  line: string,
  severity: string | undefined,
): string {
  const color = getSeverityColor(severity);
  const suffixStart = line.lastIndexOf('  ');

  if (suffixStart === -1) {
    return colorText(color, line);
  }

  const title = line.slice(0, suffixStart);
  const suffix = line.slice(suffixStart);
  const suffixParts = suffix.trim().split(/\s+/u);
  const hasIssueCountSuffix =
    suffixParts.length === 2 &&
    /^\d+$/u.test(suffixParts[0] ?? '') &&
    (suffixParts[1] === 'issue' || suffixParts[1] === 'issues');

  if (!title || !hasIssueCountSuffix) {
    return colorText(color, line);
  }

  return `${colorText(color, title)}${suffix}`;
}

function colorIssueLabelLine(line: string): string {
  const match = LABEL_PREFIX_PATTERN.exec(line);

  if (!match) {
    return line;
  }

  const prefix = match[1] ?? '';
  const label = match[2] ?? '';
  const labelText = `${label}:`;
  const labelStart = prefix.length;
  const labelEnd = labelStart + labelText.length;

  return `${prefix}${colorText(getLabelColor(label), labelText)}${line.slice(labelEnd)}`;
}

function colorIssueBlockLines(
  lines: readonly string[],
  options: { severity?: string },
): string[] {
  return lines.map((line, index) =>
    index === 0
      ? colorIssueTitleLine(line, options.severity)
      : colorIssueLabelLine(line),
  );
}

function formatIssueBlock(
  lines: readonly string[],
  options: { severity?: string } = {},
): string[] {
  const width = Math.max(
    ISSUE_BLOCK_MIN_WIDTH,
    getRequiredListLineWidth(lines) +
      ISSUE_BLOCK_BORDER_WIDTH +
      ISSUE_BLOCK_HORIZONTAL_PADDING,
  );
  const contentWidth = getContentWidth(width);
  const wrappedLines = lines.flatMap((line) => wrapLine(line, contentWidth));
  const coloredLines = colorIssueBlockLines(wrappedLines, options);

  return boxen(coloredLines.join('\n'), {
    borderStyle: 'single',
    padding: {
      left: 1,
      right: 1,
    },
    width,
  }).split('\n');
}

function indentDetailLines(lines: readonly string[]): string[] {
  return lines.map((line) => (line ? `    ${line}` : ''));
}

function formatEvidenceLine(evidence: LiminaCheckIssueEvidence): string[] {
  const heading = [evidence.label, evidence.value].filter(Boolean).join(': ');

  return [
    ...(heading ? [`  - ${heading}`] : []),
    ...(evidence.lines ?? []).map((line) => `    ${line}`),
  ];
}

function linesEqual(
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
  return (
    evidence?.some(
      (item) => item.lines !== undefined && linesEqual(item.lines, detailLines),
    ) ?? false
  );
}

function formatIssueDetailLines(issue: LiminaCheckIssue): string[] {
  const detailLines =
    issue.detailLines?.length &&
    !hasMatchingEvidenceLines(issue.evidence, issue.detailLines)
      ? indentDetailLines(issue.detailLines)
      : [];

  return [
    ...(issue.summary ? ['summary:', `    ${issue.summary}`] : []),
    ...(issue.evidence?.length
      ? ['evidence:', ...issue.evidence.flatMap(formatEvidenceLine)]
      : []),
    ...detailLines,
  ];
}

function formatExternalLines(
  external: LiminaCheckIssueExternal | undefined,
): string[] {
  if (!external) {
    return [];
  }

  return [
    'external:',
    ...(external.tool ? [`  tool: ${external.tool}`] : []),
    ...(external.code ? [`  code: ${external.code}`] : []),
    ...(external.message ? [`  message: ${external.message}`] : []),
    ...(external.url ? [`  url: ${external.url}`] : []),
  ];
}

function formatFixLines(group: IssueGroup): string[] {
  if (group.fixSteps?.length) {
    return [
      'fix steps:',
      ...group.fixSteps.map((step, index) => `  ${index + 1}. ${step}`),
    ];
  }

  return group.fix ? ['suggested fix:', `  ${group.fix}`] : [];
}

function formatGroupDetails(
  group: IssueGroup,
  options: { detailLimit: number; verbose: boolean },
): string[] {
  if (options.verbose) {
    return [
      'details:',
      ...group.issues.flatMap((issue, index) => [
        ...(index === 0 ? [] : ['']),
        `  - ${getIssueLocation(issue)}`,
        ...formatIssueDetailLines(issue).map((line) =>
          line ? `    ${line}` : '',
        ),
      ]),
    ];
  }

  const locations = getGroupLocations(group);
  const visibleLocations = locations.slice(0, options.detailLimit);
  const remainingLocationCount = locations.length - visibleLocations.length;
  const onlyIssue = group.issues.length === 1 ? group.issues[0] : undefined;

  if (locations.length > 0 && (group.issues.length > 1 || !onlyIssue)) {
    return [
      getGroupLocationsHeading(group),
      ...visibleLocations.map((location) => `  - ${location}`),
      ...(remainingLocationCount > 0
        ? [`  ... ${remainingLocationCount} more`]
        : []),
    ];
  }

  const onlyIssueDetails = onlyIssue ? formatIssueDetailLines(onlyIssue) : [];

  if (onlyIssueDetails.length > 0) {
    const visibleLines = onlyIssueDetails.slice(0, options.detailLimit);
    const remainingLineCount = onlyIssueDetails.length - visibleLines.length;

    return [
      'details:',
      ...visibleLines.map((line) => `  ${line}`),
      ...(remainingLineCount > 0 ? [`  ... ${remainingLineCount} more`] : []),
    ];
  }

  return [
    getGroupLocationsHeading(group),
    ...visibleLocations.map((location) => `  - ${location}`),
    ...(remainingLocationCount > 0
      ? [`  ... ${remainingLocationCount} more`]
      : []),
  ];
}

function formatIssueGroup(
  group: IssueGroup,
  options: { detailLimit: number; verbose: boolean },
): string[] {
  return [
    `${group.title}  ${group.issues.length} ${plural(
      group.issues.length,
      'issue',
      'issues',
    )}`,
    `rule: ${group.code}`,
    `task: ${group.task}`,
    ...(group.domain ? [`domain: ${group.domain}`] : []),
    ...(group.detector ? [`detector: ${group.detector}`] : []),
    ...(group.severity ? [`severity: ${group.severity}`] : []),
    ...(group.packageName ? [`package: ${group.packageName}`] : []),
    ...(group.packageManifestPath
      ? [`package manifest: ${group.packageManifestPath}`]
      : []),
    ...(group.checkerName ? [`checker: ${group.checkerName}`] : []),
    ...(group.tool ? [`tool: ${group.tool}`] : []),
    ...formatExternalLines(group.external),
    '',
    ...(group.summary ? ['summary:', `  ${group.summary}`, ''] : []),
    'reason:',
    `  ${group.reason}`,
    ...(formatFixLines(group).length > 0 ? ['', ...formatFixLines(group)] : []),
    ...(group.verifyCommands?.length
      ? [
          '',
          'verify:',
          ...group.verifyCommands.map((command) => `  - ${command}`),
        ]
      : []),
    '',
    ...formatGroupDetails(group, options),
  ];
}

function hasTruncatedGroups(
  groups: readonly IssueGroup[],
  detailLimit: number,
): boolean {
  return groups.some((group) => {
    const locations = getGroupLocations(group);

    if (locations.length > detailLimit) {
      return true;
    }

    if (group.issues.length > 1) {
      return group.issues.length > detailLimit;
    }

    return group.issues[0]
      ? formatIssueDetailLines(group.issues[0]).length > detailLimit
      : false;
  });
}

export function formatCheckIssueHumanReport(
  options: CheckIssueHumanReportOptions,
): string {
  const issues = [...options.issues];
  const detailLimit = options.detailLimit ?? DEFAULT_DETAIL_LIMIT;

  if (issues.length === 0) {
    return formatCheckSummaryBlock({
      lines: ['No check issues were reported.'],
      title: options.title,
    }).join('\n');
  }

  const groups = groupIssues(issues);
  const packageCount = uniqueCount(issues, (issue) => issue.packageName);
  const scopeCount = uniqueCount(issues, (issue) => issue.scope);
  const taskCounts = countBy(issues, (issue) => issue.task);
  const ruleCounts = countBy(issues, (issue) => issue.code);
  const verboseCommand = createVerboseCommand(options.command);
  const summaryLines = [
    `Found ${issues.length} ${plural(issues.length, 'check issue', 'check issues')}.`,
    `Failed task: ${formatTopCounts(taskCounts, 3)}`,
    ...(packageCount > 0
      ? [
          `Affected packages: ${packageCount} ${plural(
            packageCount,
            'package',
            'packages',
          )}`,
        ]
      : []),
    ...(scopeCount > 0
      ? [
          `Affected scopes: ${scopeCount} ${plural(
            scopeCount,
            'scope',
            'scopes',
          )}`,
        ]
      : []),
    `Top rules: ${formatTopCounts(ruleCounts, 5)}`,
    ...(!options.verbose &&
    verboseCommand &&
    hasTruncatedGroups(groups, detailLimit)
      ? [`Show all details: ${verboseCommand}`]
      : []),
  ];

  return [
    ...formatCheckSummaryBlock({
      lines: summaryLines,
      title: options.title,
    }),
    ...groups.flatMap((group) => [
      '',
      ...formatIssueBlock(
        formatIssueGroup(group, {
          detailLimit,
          verbose: options.verbose ?? false,
        }),
        { severity: group.severity },
      ),
    ]),
  ].join('\n');
}
