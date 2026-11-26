import type { FlowRenderTreeNode, FlowTreeNodeStatus } from './render-model';

export interface FlowTreeNodeInternal {
  children: FlowTreeNodeInternal[];
  completedAt?: number;
  depth: number;
  elapsedTimeMs?: number;
  message: string;
  startedAt?: number;
  status: FlowTreeNodeStatus;
}

export interface FlowTimeInterval {
  completedAt: number;
  startedAt: number;
}

export function getElapsedOutsideChildNodes(
  node: FlowTreeNodeInternal,
  runner: FlowTimeInterval,
): number | undefined {
  const phases: FlowTimeInterval[] = [];
  for (const child of node.children) {
    const { completedAt, elapsedTimeMs } = child;
    if (
      completedAt === undefined ||
      elapsedTimeMs === undefined ||
      !Number.isFinite(elapsedTimeMs) ||
      elapsedTimeMs <= 0
    )
      continue;

    const startedAt = Math.max(runner.startedAt, completedAt - elapsedTimeMs);
    const end = Math.min(runner.completedAt, completedAt);
    if (end > startedAt) phases.push({ startedAt, completedAt: end });
  }
  if (phases.length === 0) return undefined;

  phases.sort((left, right) => left.startedAt - right.startedAt);
  let coveredUntil = runner.startedAt;
  let outside = 0;
  for (const phase of phases) {
    outside += Math.max(0, phase.startedAt - coveredUntil);
    coveredUntil = Math.max(coveredUntil, phase.completedAt);
  }
  return outside + runner.completedAt - coveredUntil;
}

export function createFlowTreeNode(
  message: string,
  depth: number,
): FlowTreeNodeInternal {
  return {
    children: [],
    depth,
    message,
    status: 'planned',
  };
}

export function appendFlowTreeChild(
  parent: FlowTreeNodeInternal,
  message: string,
  depth: number,
): FlowTreeNodeInternal {
  const childNode = createFlowTreeNode(message, depth);

  parent.children.push(childNode);

  return childNode;
}

export function cloneFlowTreeNode(
  node: FlowTreeNodeInternal,
): FlowRenderTreeNode {
  return {
    children: node.children.map(cloneFlowTreeNode),
    depth: node.depth,
    elapsedTimeMs: node.elapsedTimeMs,
    message: node.message,
    status: node.status,
  };
}

export function skipPlannedTreeDescendants(node: FlowTreeNodeInternal): void {
  for (const child of node.children) {
    if (child.status === 'planned') {
      child.status = 'skipped';
    }

    skipPlannedTreeDescendants(child);
  }
}
