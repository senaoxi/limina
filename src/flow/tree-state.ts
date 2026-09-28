import type { FlowRenderTreeNode, FlowTreeNodeStatus } from './render-model';

export interface FlowTreeNodeInternal {
  children: FlowTreeNodeInternal[];
  depth: number;
  elapsedTimeMs?: number;
  message: string;
  startedAt?: number;
  status: FlowTreeNodeStatus;
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
