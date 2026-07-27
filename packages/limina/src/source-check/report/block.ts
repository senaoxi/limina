import { colorText } from '#utils/reporting';
import boxen from 'boxen';

const ISSUE_BLOCK_MIN_WIDTH = 88;
const ISSUE_BLOCK_HORIZONTAL_PADDING = 2;
const ISSUE_BLOCK_BORDER_WIDTH = 2;
const ANSI_BLUE = '\u001B[34m';
const ANSI_CYAN = '\u001B[36m';
const ANSI_GREEN = '\u001B[32m';
const ANSI_MAGENTA = '\u001B[35m';
const ANSI_RED = '\u001B[31m';
const ANSI_YELLOW = '\u001B[33m';
const LABEL_PREFIX_PATTERN = /^(\s*(?:-\s+|\d+\.\s+)?)([A-Za-z][A-Za-z ]*):/u;

interface LineWrapPrefix {
  content: string;
  firstPrefix: string;
  nextPrefix: string;
}

const LABEL_COLORS = new Map<string, string>([
  ['fix', ANSI_GREEN],
  ['fix steps', ANSI_GREEN],
  ['suggested fix', ANSI_GREEN],
  ['suggested fixes', ANSI_GREEN],
  ['reason', ANSI_YELLOW],
  ['details', ANSI_MAGENTA],
  ['evidence', ANSI_MAGENTA],
  ['rule', ANSI_BLUE],
]);

function getLabelColor(label: string): string {
  return LABEL_COLORS.get(label.toLowerCase()) ?? ANSI_CYAN;
}

function getMatchedText(match: RegExpExecArray, index: number): string {
  const value = match[index];
  return value === undefined ? '' : value;
}

function colorIssueLabelLine(line: string): string {
  const match = LABEL_PREFIX_PATTERN.exec(line);
  if (match === null) return line;
  const prefix = getMatchedText(match, 1);
  const label = getMatchedText(match, 2);
  return `${prefix}${colorText(getLabelColor(label), line.slice(prefix.length))}`;
}

function colorIssueBlockLines(lines: readonly string[]): string[] {
  return lines.map((line, index) =>
    index === 0 ? colorText(ANSI_RED, line) : colorIssueLabelLine(line),
  );
}

function getLabelWrapPrefix(line: string): string | undefined {
  return /^\s*(?:-\s+|\d+\.\s+)?[A-Za-z][A-Za-z ]*:\s+/u.exec(line)?.[0];
}

function getListWrapPrefix(line: string): string {
  return /^\s*(?:-\s+|\d+\.\s+)?/u.exec(line)?.[0] ?? '';
}

function createWrapPrefix(line: string, prefix: string): LineWrapPrefix {
  return {
    content: line.slice(prefix.length),
    firstPrefix: prefix,
    nextPrefix: ' '.repeat(prefix.length),
  };
}

function getLineWrapPrefix(line: string): LineWrapPrefix {
  const labelPrefix = getLabelWrapPrefix(line);
  if (labelPrefix !== undefined) return createWrapPrefix(line, labelPrefix);
  return createWrapPrefix(line, getListWrapPrefix(line));
}

function splitFixedWidth(value: string, width: number): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < value.length; index += width) {
    chunks.push(value.slice(index, index + width));
  }
  return chunks;
}

function appendOversizedPathPart(options: {
  chunks: string[];
  current: string;
  part: string;
  width: number;
}): string {
  if (options.current.length > 0) options.chunks.push(options.current);
  options.chunks.push(...splitFixedWidth(options.part, options.width));
  return '';
}

function appendPathPart(options: {
  chunks: string[];
  current: string;
  part: string;
  width: number;
}): string {
  if (options.part.length > options.width) {
    return appendOversizedPathPart(options);
  }
  const combined = `${options.current}${options.part}`;
  if (combined.length <= options.width) return combined;
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
    current = appendPathPart({ chunks, current, part, width });
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function splitLongWord(word: string, width: number): string[] {
  return word.includes('/')
    ? splitPathWord(word, width)
    : splitFixedWidth(word, width);
}

function startLine(options: {
  word: string;
  width: number;
  wrapped: string[];
}): string {
  if (options.word.length <= options.width) return options.word;
  options.wrapped.push(...splitLongWord(options.word, options.width));
  return '';
}

function appendWord(options: {
  current: string;
  word: string;
  width: number;
  wrapped: string[];
}): string {
  if (options.current.length === 0) return startLine(options);
  if (options.current.length + 1 + options.word.length <= options.width) {
    return `${options.current} ${options.word}`;
  }
  options.wrapped.push(options.current);
  return startLine(options);
}

function wrapContent(content: string, width: number): string[] {
  const wrapped: string[] = [];
  let current = '';
  for (const word of content.split(/\s+/u).filter(Boolean)) {
    current = appendWord({ current, word, width, wrapped });
  }
  if (current.length > 0) wrapped.push(current);
  return wrapped;
}

function wrapIssueLine(line: string, contentWidth: number): string[] {
  if (line.length === 0) return [line];
  const prefix = getLineWrapPrefix(line);
  const width = Math.max(1, contentWidth - prefix.firstPrefix.length);
  if (prefix.content.length <= width) return [line];
  return wrapContent(prefix.content, width).map((part, index) => {
    const currentPrefix = index === 0 ? prefix.firstPrefix : prefix.nextPrefix;
    return `${currentPrefix}${part}`;
  });
}

function isFilesHeading(line: string): boolean {
  return line === 'files:' || line === 'files by scope:';
}

function getFileLineWidth(line: string, inFilesSection: boolean): number {
  if (!inFilesSection) return 0;
  return /^\s+-\s+\S/u.test(line) ? line.length : 0;
}

function getRequiredFilesLineWidth(lines: readonly string[]): number {
  let inFilesSection = false;
  let requiredWidth = 0;
  for (const line of lines) {
    if (isFilesHeading(line)) {
      inFilesSection = true;
      continue;
    }
    requiredWidth = Math.max(
      requiredWidth,
      getFileLineWidth(line, inFilesSection),
    );
  }
  return requiredWidth;
}

function getIssueBlockWidth(lines: readonly string[]): number {
  const requiredFilesWidth =
    getRequiredFilesLineWidth(lines) +
    ISSUE_BLOCK_BORDER_WIDTH +
    ISSUE_BLOCK_HORIZONTAL_PADDING;
  return Math.max(ISSUE_BLOCK_MIN_WIDTH, requiredFilesWidth);
}

export function formatSourceIssueBlock(options: {
  color: boolean;
  lines: readonly string[];
}): string[] {
  const width = getIssueBlockWidth(options.lines);
  const contentWidth = Math.max(
    1,
    width - ISSUE_BLOCK_BORDER_WIDTH - ISSUE_BLOCK_HORIZONTAL_PADDING,
  );
  const wrappedLines = options.lines.flatMap((line) =>
    wrapIssueLine(line, contentWidth),
  );
  const renderedLines = options.color
    ? colorIssueBlockLines(wrappedLines)
    : wrappedLines;
  return boxen(renderedLines.join('\n'), {
    borderStyle: 'single',
    padding: { left: 1, right: 1 },
    width,
  }).split('\n');
}
