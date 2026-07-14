export type FlowStatus =
  | 'block'
  | 'fail'
  | 'info'
  | 'pass'
  | 'planned'
  | 'skip'
  | 'start'
  | 'warn';

export type FlowTreeNodeStatus =
  | 'blocked'
  | 'failed'
  | 'passed'
  | 'planned'
  | 'running'
  | 'skipped';

export interface FlowRenderStaticLine {
  kind: 'line';
  line: string;
}

export interface FlowRenderFlowLine {
  depth: number;
  elapsedTimeMs?: number;
  kind: 'flow-line';
  message: string;
  status: FlowStatus;
}

export interface FlowRenderTree {
  kind: 'tree';
}

export type FlowRenderHistoryEntry =
  | FlowRenderFlowLine
  | FlowRenderStaticLine
  | FlowRenderTree;

export interface FlowRenderTreeNode {
  children: FlowRenderTreeNode[];
  depth: number;
  elapsedTimeMs?: number;
  message: string;
  status: FlowTreeNodeStatus;
}

export interface FlowRenderSnapshot {
  compactMode?: 'check-flow';
  entries: FlowRenderHistoryEntry[];
  outroMessage?: string;
  terminalDimensions?: FlowTerminalDimensions;
  treeRoots: FlowRenderTreeNode[];
}

export interface FlowOutputMessage {
  stream?: 'stderr' | 'stdout';
  text: string;
}

export type FlowWritableChunk = string | Uint8Array;

export type FlowRendererProcessMessage =
  | {
      snapshot: FlowRenderSnapshot;
      type: 'close';
    }
  | {
      output: FlowOutputMessage;
      type: 'output';
    }
  | {
      snapshot: FlowRenderSnapshot;
      type: 'snapshot';
    };

export type FlowRendererParentMessage =
  | {
      type: 'ready';
    }
  | {
      type: 'closed';
    }
  | {
      message: string;
      type: 'failed';
    };

export interface FlowTerminalDimensions {
  columns?: number;
  rows?: number;
}

const ANSI_RESET = '\u001B[0m';
const ANSI_GREEN = '\u001B[32m';
const ANSI_RED = '\u001B[31m';
const ANSI_YELLOW = '\u001B[33m';
const DEFAULT_TERMINAL_COLUMNS = 80;
const TERMINAL_FRAME_MARGIN_LINES = 1;
const TERMINAL_FRAME_CONTEXT_LINES = 6;
const OMITTED_LINES_MARKER = '│  ...';
const ANSI_ESCAPE = String.fromCodePoint(0x1b);
const ANSI_PATTERN = new RegExp(
  String.raw`${ANSI_ESCAPE}\[[\d:;<=>?]*[\u0020-\u002F]*[\u0040-\u007E]`,
  'gu',
);

export const SPINNER_FRAMES = [
  '⠋',
  '⠙',
  '⠹',
  '⠸',
  '⠼',
  '⠴',
  '⠦',
  '⠧',
  '⠇',
  '⠏',
] as const;
export const SPINNER_INTERVAL_MS = 80;

const FLOW_SYMBOL_BY_STATUS: Record<FlowStatus, string> = {
  block: '⊘',
  fail: '✕',
  info: '│',
  pass: '◆',
  planned: '◇',
  skip: '◇',
  start: '◇',
  warn: '▲',
};

function colorInteractiveSymbol(status: FlowStatus, symbol: string): string {
  if (status === 'pass') {
    return `${ANSI_GREEN}${symbol}${ANSI_RESET}`;
  }

  if (status === 'fail') {
    return `${ANSI_RED}${symbol}${ANSI_RESET}`;
  }

  if (status === 'warn' || status === 'block') {
    return `${ANSI_YELLOW}${symbol}${ANSI_RESET}`;
  }

  return symbol;
}

export function formatElapsedTime(milliseconds: number): string {
  if (milliseconds < 1000) {
    return `${Math.round(milliseconds)}ms`;
  }

  return `${(milliseconds / 1000).toFixed(2)}s`;
}

export function formatMessageWithElapsed(
  message: string,
  elapsedTimeMs: number | undefined,
): string {
  return typeof elapsedTimeMs === 'number'
    ? `${message} (${formatElapsedTime(elapsedTimeMs)})`
    : message;
}

export function indentMessage(message: string, depth: number): string {
  if (depth <= 0) {
    return message;
  }

  return `${'  '.repeat(depth)}${message}`;
}

export function formatInteractiveLine(
  status: FlowStatus,
  message: string,
  depth: number,
  spinnerFrameIndex: number,
): string {
  const renderedMessage = indentMessage(message, depth);
  const symbol =
    status === 'start'
      ? SPINNER_FRAMES[spinnerFrameIndex % SPINNER_FRAMES.length]!
      : FLOW_SYMBOL_BY_STATUS[status];

  return `${colorInteractiveSymbol(status, symbol)}    ${renderedMessage}`;
}

export function toTreeFlowStatus(status: FlowTreeNodeStatus): FlowStatus {
  switch (status) {
    case 'blocked': {
      return 'block';
    }
    case 'failed': {
      return 'fail';
    }
    case 'passed': {
      return 'pass';
    }
    case 'planned': {
      return 'planned';
    }
    case 'running': {
      return 'start';
    }
    case 'skipped': {
      return 'skip';
    }
  }

  throw new Error(`Unsupported flow tree node status: ${status}`);
}

function isTreeNodeTerminal(node: FlowRenderTreeNode): boolean {
  return (
    node.status === 'failed' ||
    node.status === 'blocked' ||
    node.status === 'passed' ||
    node.status === 'skipped'
  );
}

function areTreeNodeDescendantsTerminal(node: FlowRenderTreeNode): boolean {
  return node.children.every(
    (child) =>
      isTreeNodeTerminal(child) && areTreeNodeDescendantsTerminal(child),
  );
}

function renderTreeNodeLine(
  node: FlowRenderTreeNode,
  spinnerFrameIndex: number,
): string {
  const elapsedTimeMs =
    isTreeNodeTerminal(node) && areTreeNodeDescendantsTerminal(node)
      ? node.elapsedTimeMs
      : undefined;

  return formatInteractiveLine(
    toTreeFlowStatus(node.status),
    formatMessageWithElapsed(node.message, elapsedTimeMs),
    node.depth,
    spinnerFrameIndex,
  );
}

function renderTreeNodeLines(
  node: FlowRenderTreeNode,
  spinnerFrameIndex: number,
): string[] {
  const line = renderTreeNodeLine(node, spinnerFrameIndex);

  return [
    line,
    ...node.children.flatMap((child) =>
      renderTreeNodeLines(child, spinnerFrameIndex),
    ),
  ];
}

function renderCompactTreeNodeLines(
  node: FlowRenderTreeNode,
  spinnerFrameIndex: number,
): string[] {
  return [
    renderTreeNodeLine(node, spinnerFrameIndex),
    ...node.children.map((child) =>
      renderTreeNodeLine(child, spinnerFrameIndex),
    ),
  ];
}

export function renderSnapshotLines(
  snapshot: FlowRenderSnapshot,
  spinnerFrameIndex: number,
): string[] {
  const lines = snapshot.entries.flatMap((entry) => {
    if (entry.kind === 'line') {
      return [entry.line];
    }

    if (entry.kind === 'flow-line') {
      return [
        formatInteractiveLine(
          entry.status,
          formatMessageWithElapsed(entry.message, entry.elapsedTimeMs),
          entry.depth,
          spinnerFrameIndex,
        ),
      ];
    }

    return snapshot.treeRoots.flatMap((root) =>
      renderTreeNodeLines(root, spinnerFrameIndex),
    );
  });

  return snapshot.outroMessage
    ? [...lines, `└  ${snapshot.outroMessage}`]
    : lines;
}

function renderCompactSnapshotLines(
  snapshot: FlowRenderSnapshot,
  spinnerFrameIndex: number,
): string[] {
  const flowLineDepths = snapshot.entries
    .filter((entry): entry is FlowRenderFlowLine => entry.kind === 'flow-line')
    .map((entry) => entry.depth);
  const maxCompactFlowLineDepth =
    flowLineDepths.length > 0
      ? Math.min(...flowLineDepths) + 1
      : Number.POSITIVE_INFINITY;
  const lines = snapshot.entries.flatMap((entry) => {
    if (entry.kind === 'line') {
      return [entry.line];
    }

    if (entry.kind === 'flow-line') {
      if (entry.depth > maxCompactFlowLineDepth) {
        return [];
      }

      return [
        formatInteractiveLine(
          entry.status,
          formatMessageWithElapsed(entry.message, entry.elapsedTimeMs),
          entry.depth,
          spinnerFrameIndex,
        ),
      ];
    }

    return snapshot.treeRoots.flatMap((root) =>
      renderCompactTreeNodeLines(root, spinnerFrameIndex),
    );
  });

  return snapshot.outroMessage
    ? [...lines, `└  ${snapshot.outroMessage}`]
    : lines;
}

export function stripControlSequences(text: string): string {
  return text.replaceAll(ANSI_PATTERN, '').replaceAll('\r', '');
}

function countRenderedTerminalRows(line: string, columns: number): number {
  const text = stripControlSequences(line);
  let column = 0;
  let rows = 1;

  for (const char of text) {
    if (char === '\n') {
      rows += 1;
      column = 0;
      continue;
    }

    column += 1;

    if (column >= columns) {
      rows += 1;
      column = 0;
    }
  }

  return rows;
}

function countRenderedRows(
  lines: string[],
  dimensions: FlowTerminalDimensions,
): number {
  const columns = Math.max(1, dimensions.columns ?? DEFAULT_TERMINAL_COLUMNS);

  return lines.reduce(
    (sum, line) => sum + countRenderedTerminalRows(line, columns),
    0,
  );
}

function fitsRenderedLines(
  lines: string[],
  dimensions: FlowTerminalDimensions,
  options: { reserveContext?: boolean } = {},
): boolean {
  if (dimensions.rows === undefined) {
    return true;
  }

  const contextLines =
    options.reserveContext && dimensions.rows > TERMINAL_FRAME_CONTEXT_LINES * 2
      ? TERMINAL_FRAME_CONTEXT_LINES
      : 0;
  const lineLimit = Math.max(
    1,
    dimensions.rows - TERMINAL_FRAME_MARGIN_LINES - contextLines,
  );

  return countRenderedRows(lines, dimensions) <= lineLimit;
}

export function fitRenderedLinesToTerminal(
  lines: string[],
  dimensions: FlowTerminalDimensions,
  options: { omittedLines?: boolean } = {},
): string[] {
  if (fitsRenderedLines(lines, dimensions) && !options.omittedLines) {
    return lines;
  }

  if (dimensions.rows === undefined) {
    return options.omittedLines ? addOmittedLinesMarker(lines) : lines;
  }

  const lineLimit = Math.max(1, dimensions.rows - TERMINAL_FRAME_MARGIN_LINES);
  const columns = Math.max(1, dimensions.columns ?? DEFAULT_TERMINAL_COLUMNS);
  const lastLine = lines.at(-1);
  const shouldPreserveOutro = lastLine?.startsWith('└  ') ?? false;
  const bodyLineCount = lines.length - (shouldPreserveOutro ? 1 : 0);
  const bodyLines = lines.slice(0, bodyLineCount);
  const ellipsisRows = countRenderedTerminalRows(OMITTED_LINES_MARKER, columns);
  const reservedRows =
    shouldPreserveOutro && lastLine
      ? countRenderedTerminalRows(lastLine, columns)
      : 0;
  const availableBodyRows = Math.max(0, lineLimit - reservedRows);
  const bodyRows = countRenderedRows(bodyLines, {
    columns,
  });
  // The final status line is the anchor for a completed flow. When body lines
  // are hidden, reserve the omission marker before fitting normal body rows so
  // the last visible task cannot consume its slot.
  const shouldShowOmissionMarker =
    (options.omittedLines === true || bodyRows > availableBodyRows) &&
    availableBodyRows >= ellipsisRows;
  const fittedLines: string[] = [];
  let remainingRows = availableBodyRows;

  if (shouldShowOmissionMarker) {
    remainingRows -= ellipsisRows;
  }

  for (let index = 0; index < bodyLineCount && remainingRows > 0; index++) {
    const line = lines[index]!;
    const rowCount = countRenderedTerminalRows(line, columns);

    if (rowCount > remainingRows) {
      break;
    }

    fittedLines.push(line);
    remainingRows -= rowCount;
  }

  if (shouldShowOmissionMarker) {
    fittedLines.push(OMITTED_LINES_MARKER);
  }

  if (shouldPreserveOutro && lastLine && reservedRows <= lineLimit) {
    fittedLines.push(lastLine);
  }

  if (fittedLines.length > 0) {
    return fittedLines;
  }

  return lines.slice(0, 1);
}

function addOmittedLinesMarker(lines: string[]): string[] {
  if (lines.includes(OMITTED_LINES_MARKER)) {
    return lines;
  }

  const lastLine = lines.at(-1);

  if (lastLine?.startsWith('└  ')) {
    return [...lines.slice(0, -1), OMITTED_LINES_MARKER, lastLine];
  }

  return [...lines, OMITTED_LINES_MARKER];
}

export function renderSnapshotLinesForTerminal(
  snapshot: FlowRenderSnapshot,
  spinnerFrameIndex: number,
  dimensions: FlowTerminalDimensions,
): string[] {
  const shouldPreferCompact =
    snapshot.compactMode === 'check-flow' &&
    snapshot.outroMessage !== undefined;
  const fullLines = renderSnapshotLines(snapshot, spinnerFrameIndex);

  if (
    !shouldPreferCompact &&
    fitsRenderedLines(fullLines, dimensions, {
      reserveContext: true,
    })
  ) {
    return fullLines;
  }

  const compactLines = renderCompactSnapshotLines(snapshot, spinnerFrameIndex);
  const omittedLines = compactLines.length < fullLines.length;

  return fitRenderedLinesToTerminal(compactLines, dimensions, {
    omittedLines,
  });
}

export function hasRunningSnapshotWork(snapshot: FlowRenderSnapshot): boolean {
  const hasRunningTreeNode = (node: FlowRenderTreeNode): boolean =>
    node.status === 'running' || node.children.some(hasRunningTreeNode);

  return (
    snapshot.entries.some(
      (entry) => entry.kind === 'flow-line' && entry.status === 'start',
    ) || snapshot.treeRoots.some(hasRunningTreeNode)
  );
}

export function toWritableText(chunk: FlowWritableChunk): string {
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk).toString();
  }

  return chunk;
}
