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
