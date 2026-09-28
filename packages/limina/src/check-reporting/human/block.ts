import { colorText } from '#utils/reporting';
import boxen from 'boxen';
import { getLabelColor, getSeverityColor } from './groups';

const ISSUE_BLOCK_MIN_WIDTH = 88;
const ISSUE_BLOCK_HORIZONTAL_PADDING = 2;
const ISSUE_BLOCK_BORDER_WIDTH = 2;
const LABEL_PREFIX_PATTERN = /^(\s*(?:-\s+|\d+\.\s+)?)([A-Za-z][A-Za-z ]*):/u;

interface LineWrapPrefix {
  content: string;
  firstPrefix: string;
  nextPrefix: string;
}

function getLabelWrapPrefix(line: string): string | undefined {
  return /^\s*(?:-\s+|\d+\.\s+)?[A-Za-z][A-Za-z ]*:\s+/u.exec(line)?.[0];
}

function getListWrapPrefix(line: string): string {
  return /^\s*(?:-\s+|\d+\.\s+)?/u.exec(line)?.[0] ?? '';
}

function createLineWrapPrefix(line: string, prefix: string): LineWrapPrefix {
  return {
    content: line.slice(prefix.length),
    firstPrefix: prefix,
    nextPrefix: ' '.repeat(prefix.length),
  };
}

function getLineWrapPrefix(line: string): LineWrapPrefix {
  const labelPrefix = getLabelWrapPrefix(line);
  if (labelPrefix !== undefined) {
    return createLineWrapPrefix(line, labelPrefix);
  }
  return createLineWrapPrefix(line, getListWrapPrefix(line));
}

function splitFixedWidth(value: string, width: number): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < value.length; index += width) {
    chunks.push(value.slice(index, index + width));
  }
  return chunks;
}

function addOversizedPathPart(options: {
  chunks: string[];
  current: string;
  part: string;
  width: number;
}): string {
  if (options.current.length > 0) options.chunks.push(options.current);
  options.chunks.push(...splitFixedWidth(options.part, options.width));
  return '';
}

function addPathPart(options: {
  chunks: string[];
  current: string;
  part: string;
  width: number;
}): string {
  if (options.part.length > options.width) {
    return addOversizedPathPart(options);
  }
  if (options.current.length + options.part.length <= options.width) {
    return `${options.current}${options.part}`;
  }
  options.chunks.push(options.current);
  return options.part;
}

function splitPathWord(word: string, width: number): string[] {
  const chunks: string[] = [];
  const parts = word
    .split('/')
    .map((part, index, allParts) =>
      index === allParts.length - 1 ? part : `${part}/`,
    );
  let current = '';
  for (const part of parts) {
    current = addPathPart({ chunks, current, part, width });
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function splitLongWord(word: string, width: number): string[] {
  return word.includes('/')
    ? splitPathWord(word, width)
    : splitFixedWidth(word, width);
}

function startWrappedLine(options: {
  word: string;
  width: number;
  wrapped: string[];
}): string {
  if (options.word.length <= options.width) return options.word;
  options.wrapped.push(...splitLongWord(options.word, options.width));
  return '';
}

function addWordAfterCurrent(options: {
  current: string;
  word: string;
  width: number;
  wrapped: string[];
}): string {
  if (options.current.length + 1 + options.word.length <= options.width) {
    return `${options.current} ${options.word}`;
  }
  options.wrapped.push(options.current);
  return startWrappedLine(options);
}

function addWordToLine(options: {
  current: string;
  word: string;
  width: number;
  wrapped: string[];
}): string {
  if (options.current.length === 0) return startWrappedLine(options);
  return addWordAfterCurrent(options);
}

function wrapContent(content: string, width: number): string[] {
  const wrapped: string[] = [];
  let current = '';
  for (const word of content.split(/\s+/u).filter(Boolean)) {
    current = addWordToLine({ current, word, width, wrapped });
  }
  if (current.length > 0) wrapped.push(current);
  return wrapped;
}

function applyWrapPrefixes(
  wrapped: readonly string[],
  prefix: LineWrapPrefix,
): string[] {
  return wrapped.map((part, index) => {
    const currentPrefix = index === 0 ? prefix.firstPrefix : prefix.nextPrefix;
    return `${currentPrefix}${part}`;
  });
}

function wrapLine(line: string, contentWidth: number): string[] {
  if (line.length === 0) return [line];
  const prefix = getLineWrapPrefix(line);
  const width = Math.max(1, contentWidth - prefix.firstPrefix.length);
  if (prefix.content.length <= width) return [line];
  return applyWrapPrefixes(wrapContent(prefix.content, width), prefix);
}

function getContentWidth(blockWidth: number): number {
  return Math.max(
    1,
    blockWidth - ISSUE_BLOCK_BORDER_WIDTH - ISSUE_BLOCK_HORIZONTAL_PADDING,
  );
}

function isListLine(line: string): boolean {
  return /^\s+-\s+\S/u.test(line);
}

function getRequiredListLineWidth(lines: readonly string[]): number {
  return lines.reduce(
    (width, line) => (isListLine(line) ? Math.max(width, line.length) : width),
    0,
  );
}

function hasTwoParts(parts: readonly string[]): boolean {
  return parts.length === 2;
}

function hasNumericCount(parts: readonly string[]): boolean {
  return /^\d+$/u.test(parts[0] ?? '');
}

function hasIssueNoun(parts: readonly string[]): boolean {
  return ['issue', 'issues'].includes(parts[1] ?? '');
}

function isIssueCountSuffix(parts: readonly string[]): boolean {
  return [hasTwoParts, hasNumericCount, hasIssueNoun].every((check) =>
    check(parts),
  );
}

function createIssueCountSuffix(
  line: string,
  suffixStart: number,
): { suffix: string; title: string } | null {
  const title = line.slice(0, suffixStart);
  if (title.length === 0) return null;
  const suffix = line.slice(suffixStart);
  return isIssueCountSuffix(suffix.trim().split(/\s+/u))
    ? { suffix, title }
    : null;
}

function parseIssueCountSuffix(line: string): {
  suffix: string;
  title: string;
} | null {
  const suffixStart = line.lastIndexOf('  ');
  return suffixStart === -1 ? null : createIssueCountSuffix(line, suffixStart);
}

function colorIssueTitleLine(
  line: string,
  severity: string | undefined,
): string {
  const parsed = parseIssueCountSuffix(line);
  const color = getSeverityColor(severity);
  if (parsed === null) return colorText(color, line);
  return `${colorText(color, parsed.title)}${parsed.suffix}`;
}

function getMatchPart(match: RegExpExecArray, index: number): string {
  return match[index] ?? '';
}

function colorIssueLabelLine(line: string): string {
  const match = LABEL_PREFIX_PATTERN.exec(line);
  if (match === null) return line;
  const prefix = getMatchPart(match, 1);
  const label = getMatchPart(match, 2);
  const labelText = `${label}:`;
  const labelEnd = prefix.length + labelText.length;
  return `${prefix}${colorText(getLabelColor(label), labelText)}${line.slice(labelEnd)}`;
}

function colorIssueBlockLines(
  lines: readonly string[],
  severity: string | undefined,
): string[] {
  return lines.map((line, index) =>
    index === 0
      ? colorIssueTitleLine(line, severity)
      : colorIssueLabelLine(line),
  );
}

export function formatIssueBlock(
  lines: readonly string[],
  options: { color: boolean; severity?: string },
): string[] {
  const width = Math.max(
    ISSUE_BLOCK_MIN_WIDTH,
    getRequiredListLineWidth(lines) +
      ISSUE_BLOCK_BORDER_WIDTH +
      ISSUE_BLOCK_HORIZONTAL_PADDING,
  );
  const contentWidth = getContentWidth(width);
  const wrappedLines = lines.flatMap((line) => wrapLine(line, contentWidth));
  const renderedLines = options.color
    ? colorIssueBlockLines(wrappedLines, options.severity)
    : wrappedLines;
  return boxen(renderedLines.join('\n'), {
    borderStyle: 'single',
    padding: { left: 1, right: 1 },
    width,
  }).split('\n');
}
