import type { FlowStatus, FlowTreeNodeStatus } from './types';

const ANSI_RESET = '\u001B[0m';
const ANSI_GREEN = '\u001B[32m';
const ANSI_RED = '\u001B[31m';
const ANSI_YELLOW = '\u001B[33m';

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

const ANSI_COLOR_BY_STATUS: Partial<Record<FlowStatus, string>> = {
  block: ANSI_YELLOW,
  fail: ANSI_RED,
  pass: ANSI_GREEN,
  warn: ANSI_YELLOW,
};

const TREE_FLOW_STATUS: Record<FlowTreeNodeStatus, FlowStatus> = {
  blocked: 'block',
  failed: 'fail',
  passed: 'pass',
  planned: 'planned',
  running: 'start',
  skipped: 'skip',
};

function colorInteractiveSymbol(status: FlowStatus, symbol: string): string {
  const color = ANSI_COLOR_BY_STATUS[status];
  return color === undefined ? symbol : `${color}${symbol}${ANSI_RESET}`;
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

type FormatInteractiveLineArgs = [
  status: FlowStatus,
  message: string,
  depth: number,
  spinnerFrameIndex: number,
];

function getInteractiveSymbol(
  status: FlowStatus,
  spinnerFrameIndex: number,
): string {
  if (status !== 'start') {
    return FLOW_SYMBOL_BY_STATUS[status];
  }

  return SPINNER_FRAMES[spinnerFrameIndex % SPINNER_FRAMES.length]!;
}

export function formatInteractiveLine(
  ...args: FormatInteractiveLineArgs
): string {
  const [status, message, depth, spinnerFrameIndex] = args;
  const renderedMessage = indentMessage(message, depth);
  const symbol = getInteractiveSymbol(status, spinnerFrameIndex);
  return `${colorInteractiveSymbol(status, symbol)}    ${renderedMessage}`;
}

export function toTreeFlowStatus(status: FlowTreeNodeStatus): FlowStatus {
  return TREE_FLOW_STATUS[status];
}
