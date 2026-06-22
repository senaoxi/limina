export type FlowStatus =
  | 'fail'
  | 'info'
  | 'pass'
  | 'planned'
  | 'skip'
  | 'start'
  | 'warn';

export type FlowTreeNodeStatus =
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
  entries: FlowRenderHistoryEntry[];
  outroMessage?: string;
  treeRoots: FlowRenderTreeNode[];
}

export interface FlowOutputMessage {
  stream?: 'stderr' | 'stdout';
  text: string;
}

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
      type: 'closed';
    }
  | {
      message: string;
      type: 'failed';
    };

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

  if (status === 'warn') {
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

function renderTreeNodeLines(
  node: FlowRenderTreeNode,
  spinnerFrameIndex: number,
): string[] {
  const elapsedTimeMs =
    isTreeNodeTerminal(node) && areTreeNodeDescendantsTerminal(node)
      ? node.elapsedTimeMs
      : undefined;
  const line = formatInteractiveLine(
    toTreeFlowStatus(node.status),
    formatMessageWithElapsed(node.message, elapsedTimeMs),
    node.depth,
    spinnerFrameIndex,
  );

  return [
    line,
    ...node.children.flatMap((child) =>
      renderTreeNodeLines(child, spinnerFrameIndex),
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

export function hasRunningSnapshotWork(snapshot: FlowRenderSnapshot): boolean {
  const hasRunningTreeNode = (node: FlowRenderTreeNode): boolean =>
    node.status === 'running' || node.children.some(hasRunningTreeNode);

  return (
    snapshot.entries.some(
      (entry) => entry.kind === 'flow-line' && entry.status === 'start',
    ) || snapshot.treeRoots.some(hasRunningTreeNode)
  );
}

export function toWritableText(chunk: unknown): string {
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk).toString();
  }

  return String(chunk);
}
