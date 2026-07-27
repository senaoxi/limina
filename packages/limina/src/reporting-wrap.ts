export const CHECK_SUMMARY_BLOCK_MIN_WIDTH = 88;
const CHECK_BLOCK_HORIZONTAL_PADDING = 2;
const CHECK_BLOCK_BORDER_WIDTH = 2;

interface LineWrapPrefix {
  content: string;
  firstPrefix: string;
  nextPrefix: string;
}

interface WrapState {
  current: string;
  wrapped: string[];
}

interface PathChunkState {
  chunks: string[];
  current: string;
}

function isEmptyDetails(
  details: string | readonly string[] | undefined,
): details is '' | undefined {
  return details === undefined || details === '';
}

export function splitDetailBlocks(
  details: string | readonly string[] | undefined,
): string[][] {
  if (isEmptyDetails(details)) {
    return [];
  }

  if (typeof details !== 'string') {
    return [[...details]];
  }

  return details
    .split(/\n{2,}/u)
    .map((block) => block.split('\n'))
    .filter((lines) => lines.some((line) => line.trim().length > 0));
}

export function getBlockContentWidth(blockWidth: number): number {
  return Math.max(
    1,
    blockWidth - CHECK_BLOCK_BORDER_WIDTH - CHECK_BLOCK_HORIZONTAL_PADDING,
  );
}

function getMatchText(pattern: RegExp, line: string): string | null {
  const match = pattern.exec(line);
  return match === null ? null : match[0];
}

function getLineWrapPrefix(line: string): LineWrapPrefix {
  const labelPrefix = getMatchText(
    /^\s*(?:-\s+|\d+\.\s+)?[A-Za-z][A-Za-z ]*:\s+/u,
    line,
  );

  if (labelPrefix !== null) {
    return {
      content: line.slice(labelPrefix.length),
      firstPrefix: labelPrefix,
      nextPrefix: ' '.repeat(labelPrefix.length),
    };
  }

  const firstPrefix = getMatchText(/^\s*(?:-\s+|\d+\.\s+)?/u, line) ?? '';
  return {
    content: line.slice(firstPrefix.length),
    firstPrefix,
    nextPrefix: ' '.repeat(firstPrefix.length),
  };
}

function splitFixedWidth(value: string, width: number): string[] {
  const chunks: string[] = [];

  for (let index = 0; index < value.length; index += width) {
    chunks.push(value.slice(index, index + width));
  }

  return chunks;
}

function flushPathChunk(state: PathChunkState): void {
  if (state.current.length > 0) {
    state.chunks.push(state.current);
    state.current = '';
  }
}

function appendOversizedPathPart(options: {
  part: string;
  state: PathChunkState;
  width: number;
}): void {
  flushPathChunk(options.state);
  options.state.chunks.push(...splitFixedWidth(options.part, options.width));
}

function shouldFlushPathChunk(options: {
  part: string;
  state: PathChunkState;
  width: number;
}): boolean {
  return (
    options.state.current.length > 0 &&
    options.state.current.length + options.part.length > options.width
  );
}

function appendRegularPathPart(options: {
  part: string;
  state: PathChunkState;
  width: number;
}): void {
  if (shouldFlushPathChunk(options)) {
    flushPathChunk(options.state);
  }

  options.state.current = `${options.state.current}${options.part}`;
}

function appendPathPart(options: {
  part: string;
  state: PathChunkState;
  width: number;
}): void {
  if (options.part.length > options.width) {
    appendOversizedPathPart(options);
    return;
  }

  appendRegularPathPart(options);
}

function addPathSeparator(
  part: string,
  index: number,
  partCount: number,
): string {
  return index === partCount - 1 ? part : `${part}/`;
}

function splitPathWord(word: string, width: number): string[] {
  const state: PathChunkState = { chunks: [], current: '' };
  const parts = word
    .split('/')
    .map((part, index, values) => addPathSeparator(part, index, values.length));

  for (const part of parts) {
    appendPathPart({ part, state, width });
  }

  flushPathChunk(state);
  return state.chunks;
}

function splitLongWord(word: string, width: number): string[] {
  return word.includes('/')
    ? splitPathWord(word, width)
    : splitFixedWidth(word, width);
}

function startWrapLine(state: WrapState, word: string, width: number): void {
  if (word.length > width) {
    state.wrapped.push(...splitLongWord(word, width));
    return;
  }

  state.current = word;
}

function tryStartWrapLine(
  state: WrapState,
  word: string,
  width: number,
): boolean {
  if (state.current.length > 0) {
    return false;
  }

  startWrapLine(state, word, width);
  return true;
}

function tryAppendToWrapLine(
  state: WrapState,
  word: string,
  width: number,
): boolean {
  if (state.current.length + 1 + word.length > width) {
    return false;
  }

  state.current = `${state.current} ${word}`;
  return true;
}

function appendWrapWord(state: WrapState, word: string, width: number): void {
  if (tryStartWrapLine(state, word, width)) {
    return;
  }

  if (tryAppendToWrapLine(state, word, width)) {
    return;
  }

  state.wrapped.push(state.current);
  state.current = '';
  startWrapLine(state, word, width);
}

function getContentWords(content: string): string[] {
  return content.split(/\s+/u).filter((word) => word.length > 0);
}

function wrapContent(content: string, width: number): string[] {
  const state: WrapState = { current: '', wrapped: [] };

  for (const word of getContentWords(content)) {
    appendWrapWord(state, word, width);
  }

  if (state.current.length > 0) {
    state.wrapped.push(state.current);
  }

  return state.wrapped;
}

function applyWrapPrefixes(
  parts: readonly string[],
  prefix: LineWrapPrefix,
): string[] {
  return parts.map((part, index) =>
    index === 0
      ? `${prefix.firstPrefix}${part}`
      : `${prefix.nextPrefix}${part}`,
  );
}

export function wrapDetailLine(line: string, contentWidth: number): string[] {
  if (line.length === 0) {
    return [line];
  }

  const prefix = getLineWrapPrefix(line);
  const continuationWidth = Math.max(
    1,
    contentWidth - prefix.firstPrefix.length,
  );

  if (prefix.content.length <= continuationWidth) {
    return [line];
  }

  return applyWrapPrefixes(
    wrapContent(prefix.content, continuationWidth),
    prefix,
  );
}
