import { plural } from '#utils/reporting';
import boxen from 'boxen';
import {
  type CheckSummaryBlockColor,
  colorSummaryBlockBorder,
  colorSummaryLabel,
} from './reporting-colors';
import {
  CHECK_SUMMARY_BLOCK_MIN_WIDTH,
  getBlockContentWidth,
  splitDetailBlocks,
  wrapDetailLine,
} from './reporting-wrap';

interface CheckSummaryBlockOptions {
  borderColor?: CheckSummaryBlockColor;
  color: boolean;
  colorLine?: (line: string) => string;
  lines: readonly string[];
  title: string;
}

function renderBox(options: {
  borderStyle: 'round' | 'single';
  lines: readonly string[];
  title?: string;
}): string[] {
  return boxen(options.lines.join('\n'), {
    borderStyle: options.borderStyle,
    padding: { left: 1, right: 1 },
    title: options.title,
    width: CHECK_SUMMARY_BLOCK_MIN_WIDTH,
  }).split('\n');
}

export function formatCheckDetailBlock(lines: readonly string[]): string[] {
  const contentWidth = getBlockContentWidth(CHECK_SUMMARY_BLOCK_MIN_WIDTH);
  const wrappedLines = lines.flatMap((line) =>
    wrapDetailLine(line, contentWidth),
  );
  return renderBox({ borderStyle: 'single', lines: wrappedLines });
}

function shouldColorLabels(options: CheckSummaryBlockOptions): boolean {
  return options.color && options.borderColor !== undefined;
}

function applyLabelColors(
  lines: readonly string[],
  enabled: boolean,
): string[] {
  return enabled ? lines.map(colorSummaryLabel) : [...lines];
}

function applyLineColors(
  lines: readonly string[],
  options: CheckSummaryBlockOptions,
): string[] {
  if (!options.color) {
    return [...lines];
  }

  if (options.colorLine === undefined) {
    return [...lines];
  }

  return lines.map(options.colorLine);
}

function applyBorderColor(
  lines: readonly string[],
  options: CheckSummaryBlockOptions,
): string[] {
  if (!options.color) {
    return [...lines];
  }

  if (options.borderColor === undefined) {
    return [...lines];
  }

  return colorSummaryBlockBorder(lines, options.borderColor);
}

export function formatCheckSummaryBlock(
  options: CheckSummaryBlockOptions,
): string[] {
  const contentWidth = getBlockContentWidth(CHECK_SUMMARY_BLOCK_MIN_WIDTH);
  const wrappedLines = options.lines.flatMap((line) =>
    wrapDetailLine(line, contentWidth),
  );
  const labeledLines = applyLabelColors(
    wrappedLines,
    shouldColorLabels(options),
  );
  const renderedLines = applyLineColors(labeledLines, options);
  const blockLines = renderBox({
    borderStyle: 'round',
    lines: renderedLines,
    title: options.title,
  });
  return applyBorderColor(blockLines, options);
}

function formatDetailBlocks(
  details: string | readonly string[] | undefined,
): string[] {
  return splitDetailBlocks(details).flatMap((detailLines) => [
    '',
    ...formatCheckDetailBlock(detailLines),
  ]);
}

export function formatCheckSummaryReport(options: {
  color: boolean;
  details?: string | readonly string[];
  lines: readonly string[];
  title: string;
}): string {
  return [
    ...formatCheckSummaryBlock({
      color: options.color,
      lines: options.lines,
      title: options.title,
    }),
    ...formatDetailBlocks(options.details),
  ].join('\n');
}

export function formatCheckIssueSummaryReport(options: {
  color: boolean;
  details?: string | readonly string[];
  issueCount: number;
  pluralIssueLabel: string;
  singularIssueLabel: string;
  title: string;
}): string {
  const issueLabel = plural(
    options.issueCount,
    options.singularIssueLabel,
    options.pluralIssueLabel,
  );
  return formatCheckSummaryReport({
    color: options.color,
    details: options.details,
    lines: [`Found ${options.issueCount} ${issueLabel}.`],
    title: options.title,
  });
}
