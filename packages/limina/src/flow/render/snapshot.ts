import {
  formatInteractiveLine,
  formatMessageWithElapsed,
  toTreeFlowStatus,
} from './format';
import type {
  FlowRenderFlowLine,
  FlowRenderHistoryEntry,
  FlowRenderSnapshot,
  FlowRenderTreeNode,
  FlowWritableChunk,
} from './types';

const terminalTreeStatuses = new Set([
  'blocked',
  'failed',
  'passed',
  'skipped',
]);

function isTreeNodeTerminal(node: FlowRenderTreeNode): boolean {
  return terminalTreeStatuses.has(node.status);
}

function areTreeNodeDescendantsTerminal(node: FlowRenderTreeNode): boolean {
  return node.children.every(isTerminalTreeBranch);
}

function isTerminalTreeBranch(node: FlowRenderTreeNode): boolean {
  return isTreeNodeTerminal(node) && areTreeNodeDescendantsTerminal(node);
}

function getTreeNodeElapsedTime(node: FlowRenderTreeNode): number | undefined {
  return isTerminalTreeBranch(node) ? node.elapsedTimeMs : undefined;
}

function renderTreeNodeLine(
  node: FlowRenderTreeNode,
  spinnerFrameIndex: number,
): string {
  return formatInteractiveLine(
    toTreeFlowStatus(node.status),
    formatMessageWithElapsed(node.message, getTreeNodeElapsedTime(node)),
    node.depth,
    spinnerFrameIndex,
  );
}

function renderTreeNodeLines(
  node: FlowRenderTreeNode,
  spinnerFrameIndex: number,
): string[] {
  return [
    renderTreeNodeLine(node, spinnerFrameIndex),
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

function renderFlowLine(
  entry: FlowRenderFlowLine,
  spinnerFrameIndex: number,
): string {
  return formatInteractiveLine(
    entry.status,
    formatMessageWithElapsed(entry.message, entry.elapsedTimeMs),
    entry.depth,
    spinnerFrameIndex,
  );
}

function renderHistoryEntry(options: {
  entry: FlowRenderHistoryEntry;
  snapshot: FlowRenderSnapshot;
  spinnerFrameIndex: number;
}): string[] {
  if (options.entry.kind === 'line') {
    return [options.entry.line];
  }

  if (options.entry.kind === 'flow-line') {
    return [renderFlowLine(options.entry, options.spinnerFrameIndex)];
  }

  return options.snapshot.treeRoots.flatMap((root) =>
    renderTreeNodeLines(root, options.spinnerFrameIndex),
  );
}

function appendOutro(
  lines: string[],
  outroMessage: string | undefined,
): string[] {
  return outroMessage === undefined ? lines : [...lines, `└  ${outroMessage}`];
}

export function renderSnapshotLines(
  snapshot: FlowRenderSnapshot,
  spinnerFrameIndex: number,
): string[] {
  const lines = snapshot.entries.flatMap((entry) =>
    renderHistoryEntry({ entry, snapshot, spinnerFrameIndex }),
  );
  return appendOutro(lines, snapshot.outroMessage);
}

function getMaxCompactFlowLineDepth(
  entries: readonly FlowRenderHistoryEntry[],
): number {
  const depths = entries
    .filter((entry): entry is FlowRenderFlowLine => entry.kind === 'flow-line')
    .map((entry) => entry.depth);

  if (depths.length === 0) {
    return Number.POSITIVE_INFINITY;
  }

  return Math.min(...depths) + 1;
}

function renderCompactFlowLine(options: {
  entry: FlowRenderFlowLine;
  maxDepth: number;
  spinnerFrameIndex: number;
}): string[] {
  if (options.entry.depth > options.maxDepth) {
    return [];
  }

  return [renderFlowLine(options.entry, options.spinnerFrameIndex)];
}

function renderCompactHistoryEntry(options: {
  entry: FlowRenderHistoryEntry;
  maxDepth: number;
  snapshot: FlowRenderSnapshot;
  spinnerFrameIndex: number;
}): string[] {
  if (options.entry.kind === 'line') {
    return [options.entry.line];
  }

  if (options.entry.kind === 'flow-line') {
    return renderCompactFlowLine({
      entry: options.entry,
      maxDepth: options.maxDepth,
      spinnerFrameIndex: options.spinnerFrameIndex,
    });
  }

  return options.snapshot.treeRoots.flatMap((root) =>
    renderCompactTreeNodeLines(root, options.spinnerFrameIndex),
  );
}

export function renderCompactSnapshotLines(
  snapshot: FlowRenderSnapshot,
  spinnerFrameIndex: number,
): string[] {
  const maxDepth = getMaxCompactFlowLineDepth(snapshot.entries);
  const lines = snapshot.entries.flatMap((entry) =>
    renderCompactHistoryEntry({
      entry,
      maxDepth,
      snapshot,
      spinnerFrameIndex,
    }),
  );
  return appendOutro(lines, snapshot.outroMessage);
}

function hasRunningTreeNode(node: FlowRenderTreeNode): boolean {
  return node.status === 'running' || node.children.some(hasRunningTreeNode);
}

function hasRunningFlowEntry(entry: FlowRenderHistoryEntry): boolean {
  return entry.kind === 'flow-line' && entry.status === 'start';
}

export function hasRunningSnapshotWork(snapshot: FlowRenderSnapshot): boolean {
  return (
    snapshot.entries.some(hasRunningFlowEntry) ||
    snapshot.treeRoots.some(hasRunningTreeNode)
  );
}

export function toWritableText(chunk: FlowWritableChunk): string {
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk).toString();
  }

  return chunk;
}
