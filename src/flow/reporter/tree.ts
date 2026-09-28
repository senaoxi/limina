import { type FlowTreeNodeStatus, toTreeFlowStatus } from '../render-model';
import {
  appendFlowTreeChild,
  createFlowTreeNode,
  type FlowTreeNodeInternal,
  skipPlannedTreeDescendants,
} from '../tree-state';
import { emitFlow, formatReporterFailure, renderTreeChange } from './rendering';
import type {
  FlowReporterState,
  FlowTreeFinishInput,
  LiminaFlowFailureOptions,
  LiminaFlowMessageOptions,
  LiminaFlowTreeNode,
} from './types';

function addChild(options: {
  message: string;
  node: FlowTreeNodeInternal;
  state: FlowReporterState;
  treeOptions: LiminaFlowMessageOptions;
}): FlowTreeNodeInternal {
  const child = appendFlowTreeChild(
    options.node,
    options.message,
    options.treeOptions.depth ?? options.node.depth + 1,
  );
  renderTreeChange(options.state);
  return child;
}

function addChildren(options: {
  messages: readonly string[];
  node: FlowTreeNodeInternal;
  state: FlowReporterState;
  treeOptions: LiminaFlowMessageOptions;
}): FlowTreeNodeInternal[] {
  const children = options.messages.map((message) =>
    appendFlowTreeChild(
      options.node,
      message,
      options.treeOptions.depth ?? options.node.depth + 1,
    ),
  );
  if (children.length > 0) renderTreeChange(options.state);
  return children;
}

function applyStartedMessage(options: {
  message: string | undefined;
  node: FlowTreeNodeInternal;
}): void {
  if (options.message === undefined) return;
  options.node.message = options.message;
}

function applyTreeDepth(options: {
  depth: number | undefined;
  node: FlowTreeNodeInternal;
}): void {
  if (options.depth === undefined) return;
  options.node.depth = options.depth;
}

function updateStartedNode(options: {
  message: string | undefined;
  node: FlowTreeNodeInternal;
  treeOptions: LiminaFlowMessageOptions | undefined;
}): void {
  applyStartedMessage(options);
  applyTreeDepth({ depth: options.treeOptions?.depth, node: options.node });
  options.node.status = 'running';
  options.node.startedAt = performance.now();
  options.node.elapsedTimeMs = undefined;
}

function startTreeNode(options: {
  message: string | undefined;
  node: FlowTreeNodeInternal;
  state: FlowReporterState;
  treeOptions: LiminaFlowMessageOptions | undefined;
}): void {
  updateStartedNode(options);
  if (options.state.interactive) {
    renderTreeChange(options.state);
    return;
  }
  emitFlow(options.state, {
    options: {
      ...options.treeOptions,
      depth: options.node.depth,
    },
    rawMessage: options.node.message,
    status: 'start',
  });
}

function getRequestedTreeMessage(input: FlowTreeFinishInput): string {
  if (input.message !== undefined) return input.message;
  return input.node.message;
}

function getFinishedTreeMessage(
  state: FlowReporterState,
  input: FlowTreeFinishInput,
): string {
  const message = getRequestedTreeMessage(input);
  if (input.status !== 'failed') return message;
  return formatReporterFailure({
    message,
    options: input.options as LiminaFlowFailureOptions | undefined,
    state,
  });
}

function getExplicitElapsedTime(
  input: FlowTreeFinishInput,
): number | undefined {
  if (input.options === undefined) return undefined;
  return input.options.elapsedTimeMs;
}

function getFinishedElapsedTime(
  input: FlowTreeFinishInput,
): number | undefined {
  const explicit = getExplicitElapsedTime(input);
  if (explicit !== undefined) return explicit;
  if (input.node.startedAt === undefined) return undefined;
  return performance.now() - input.node.startedAt;
}

function updateFinishedNode(
  state: FlowReporterState,
  input: FlowTreeFinishInput,
): void {
  skipPlannedTreeDescendants(input.node);
  input.node.message = getFinishedTreeMessage(state, input);
  applyTreeDepth({ depth: input.options?.depth, node: input.node });
  input.node.status = input.status;
  input.node.elapsedTimeMs = getFinishedElapsedTime(input);
}

function finishTreeNode(
  state: FlowReporterState,
  input: FlowTreeFinishInput,
): void {
  updateFinishedNode(state, input);
  if (state.interactive) {
    renderTreeChange(state);
    return;
  }
  emitFlow(state, {
    options: {
      ...input.options,
      depth: input.node.depth,
      elapsedTimeMs: input.node.elapsedTimeMs,
    },
    rawMessage: input.node.message,
    status: toTreeFlowStatus(input.status),
  });
}

function createTreeNodeHandle(
  state: FlowReporterState,
  node: FlowTreeNodeInternal,
): LiminaFlowTreeNode {
  const finish = (
    status: Exclude<FlowTreeNodeStatus, 'planned' | 'running'>,
    message: string | undefined,
    options: LiminaFlowFailureOptions | LiminaFlowMessageOptions | undefined,
  ): void => finishTreeNode(state, { message, node, options, status });
  return {
    block: (message, options) => finish('blocked', message, options),
    child: (message, options = {}) =>
      createTreeNodeHandle(
        state,
        addChild({ message, node, state, treeOptions: options }),
      ),
    children: (messages, options = {}) =>
      addChildren({ messages, node, state, treeOptions: options }).map(
        (child) => createTreeNodeHandle(state, child),
      ),
    fail: (message, options) => finish('failed', message, options),
    pass: (message, options) => finish('passed', message, options),
    skip: (message, options) => finish('skipped', message, options),
    start: (message, options) =>
      startTreeNode({ message, node, state, treeOptions: options }),
  };
}

function ensureInteractiveTree(state: FlowReporterState): void {
  if (!state.interactive) return;
  if (state.hasInteractiveTree) return;
  state.interactiveHistory.push({ kind: 'tree' });
  state.hasInteractiveTree = true;
}

export function createReporterTree(options: {
  message: string;
  state: FlowReporterState;
  treeOptions: LiminaFlowMessageOptions;
}): LiminaFlowTreeNode {
  const node = createFlowTreeNode(
    options.message,
    options.treeOptions.depth ?? 0,
  );
  options.state.treeRoots.push(node);
  ensureInteractiveTree(options.state);
  renderTreeChange(options.state);
  return createTreeNodeHandle(options.state, node);
}
