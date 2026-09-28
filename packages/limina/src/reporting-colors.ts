import { colorText } from '#utils/reporting';

export type CheckSummaryBlockColor = 'green' | 'red';
type AnsiColor = string;

const ANSI_BLUE = '\u001B[34m';
const ANSI_CYAN = '\u001B[36m';
const ANSI_GREEN = '\u001B[32m';
const ANSI_MAGENTA = '\u001B[35m';
const ANSI_RED = '\u001B[31m';
const ANSI_YELLOW = '\u001B[33m';
const SUMMARY_LABEL_PREFIX_PATTERN =
  /^(\s*(?:-\s+|\d+\.\s+)?)([A-Za-z][A-Za-z ]*)(:)(\s*)/u;

const LABEL_COLOR_BY_NAME: Readonly<Record<string, AnsiColor>> = {
  'by rule': ANSI_BLUE,
  details: ANSI_MAGENTA,
  evidence: ANSI_MAGENTA,
  'executed tasks': ANSI_BLUE,
  external: ANSI_MAGENTA,
  'failed task': ANSI_BLUE,
  fix: ANSI_GREEN,
  fixes: ANSI_GREEN,
  'fix steps': ANSI_GREEN,
  'issue overview': ANSI_MAGENTA,
  'passed tasks': ANSI_BLUE,
  reason: ANSI_YELLOW,
  rule: ANSI_BLUE,
  rules: ANSI_BLUE,
  'suggested fix': ANSI_GREEN,
  'suggested fixes': ANSI_GREEN,
  task: ANSI_BLUE,
  tasks: ANSI_BLUE,
  'top rules': ANSI_BLUE,
  verbose: ANSI_MAGENTA,
};

function getSummaryLabelColor(label: string): AnsiColor {
  return LABEL_COLOR_BY_NAME[label.toLowerCase()] ?? ANSI_CYAN;
}

function getMatchPart(match: RegExpExecArray, index: number): string {
  return match[index] ?? '';
}

export function colorSummaryLabel(line: string): string {
  const match = SUMMARY_LABEL_PREFIX_PATTERN.exec(line);

  if (match === null) {
    return line;
  }

  const indent = getMatchPart(match, 1);
  const label = getMatchPart(match, 2);
  const colon = getMatchPart(match, 3);
  const spacing = getMatchPart(match, 4);
  const labelText = `${label}${colon}`;
  return `${indent}${colorText(getSummaryLabelColor(label), labelText)}${spacing}${line.slice(
    match[0].length,
  )}`;
}

function getBorderAnsiColor(color: CheckSummaryBlockColor): AnsiColor {
  return color === 'green' ? ANSI_GREEN : ANSI_RED;
}

function colorBorderLine(options: {
  color: AnsiColor;
  index: number;
  line: string;
  lineCount: number;
}): string {
  if (options.index === 0 || options.index === options.lineCount - 1) {
    return colorText(options.color, options.line);
  }

  return `${colorText(options.color, options.line.slice(0, 1))}${options.line.slice(
    1,
    -1,
  )}${colorText(options.color, options.line.slice(-1))}`;
}

export function colorSummaryBlockBorder(
  lines: readonly string[],
  borderColor: CheckSummaryBlockColor,
): string[] {
  const color = getBorderAnsiColor(borderColor);
  return lines.map((line, index) =>
    colorBorderLine({ color, index, line, lineCount: lines.length }),
  );
}
