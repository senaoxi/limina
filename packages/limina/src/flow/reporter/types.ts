import type { FlowProcessRenderer } from '../process-renderer';
import type {
  FlowRenderHistoryEntry,
  FlowStatus,
  FlowTreeNodeStatus,
  FlowWritableChunk,
} from '../render-model';
import type { FlowWriteStream, TerminalFrameTracker } from '../terminal-frame';
import type { FlowTreeNodeInternal } from '../tree-state';

export interface ClackLogAdapter {
  error: (message: string) => void;
  info: (message: string) => void;
  step: (message: string) => void;
  success: (message: string) => void;
  warn: (message: string) => void;
}

export interface ClackAdapter {
  intro: (message: string) => void;
  log: ClackLogAdapter;
  outro: (message: string) => void;
}

export interface FlowOutput {
  write: (message: string) => void;
}

export interface LiminaFlowReporterOptions {
  clack?: ClackAdapter;
  env?: NodeJS.ProcessEnv;
  forceTty?: boolean;
  output?: FlowOutput;
  renderer?: 'auto' | 'inline' | 'process';
  stderr?: FlowWriteStream;
  stdout?: FlowWriteStream;
}

export interface LiminaFlowMessageOptions {
  collapseOnSuccess?: boolean;
  depth?: number;
  elapsedTimeMs?: number;
  persistInteractive?: boolean;
}

export interface LiminaFlowFailureOptions extends LiminaFlowMessageOptions {
  error?: unknown;
}

export interface LiminaFlowTask {
  fail: (message?: string, options?: LiminaFlowFailureOptions) => void;
  info: (message: string, options?: LiminaFlowMessageOptions) => void;
  pass: (message?: string, options?: LiminaFlowMessageOptions) => void;
  skip: (message?: string, options?: LiminaFlowMessageOptions) => void;
  warn: (message: string, options?: LiminaFlowMessageOptions) => void;
}

export interface LiminaFlowTreeNode {
  block: (message?: string, options?: LiminaFlowMessageOptions) => void;
  child: (
    message: string,
    options?: LiminaFlowMessageOptions,
  ) => LiminaFlowTreeNode;
  children: (
    messages: readonly string[],
    options?: LiminaFlowMessageOptions,
  ) => LiminaFlowTreeNode[];
  fail: (message?: string, options?: LiminaFlowFailureOptions) => void;
  pass: (message?: string, options?: LiminaFlowMessageOptions) => void;
  skip: (message?: string, options?: LiminaFlowMessageOptions) => void;
  start: (message?: string, options?: LiminaFlowMessageOptions) => void;
}

export interface LiminaFlowOutputOptions {
  stream?: 'stderr' | 'stdout';
}

export interface InteractiveHistoryReference {
  collection: 'history';
  index: number;
}

export interface InteractiveTransientReference {
  collection: 'transient';
  id: number;
}

export type InteractiveEntryReference =
  | InteractiveHistoryReference
  | InteractiveTransientReference;

export interface ProcessTransientHistoryEntry {
  entry: FlowRenderHistoryEntry;
  id: number;
  taskId?: number;
}

export interface FlowReporterState {
  clack: ClackAdapter;
  env: NodeJS.ProcessEnv;
  hasInteractiveTree: boolean;
  interactive: boolean;
  interactiveHistory: FlowRenderHistoryEntry[];
  nextProcessTransientEntryId: number;
  nextProcessTransientTaskId: number;
  outroMessage: string | undefined;
  output: FlowOutput;
  processRenderer: FlowProcessRenderer | undefined;
  processTransientHistory: ProcessTransientHistoryEntry[];
  restoreWriteStreams: (() => void) | undefined;
  spinnerFrameIndex: number;
  spinnerTimer: NodeJS.Timeout | undefined;
  statusOnly: boolean;
  stderr: FlowWriteStream | undefined;
  stdout: FlowWriteStream | undefined;
  terminalFrame: TerminalFrameTracker;
  trackedTaskCount: number;
  tracksProcessWrites: boolean;
  treeRoots: FlowTreeNodeInternal[];
}

export interface FlowEmitMeta {
  persistInteractive?: boolean;
  transientTaskId?: number;
}

export interface FlowEmitInput {
  meta?: FlowEmitMeta;
  options: LiminaFlowMessageOptions;
  rawMessage: string;
  status: FlowStatus;
}

export interface FlowTreeFinishInput {
  message: string | undefined;
  node: FlowTreeNodeInternal;
  options: LiminaFlowFailureOptions | LiminaFlowMessageOptions | undefined;
  status: Exclude<FlowTreeNodeStatus, 'planned' | 'running'>;
}

export interface FlowWriteInput {
  message: FlowWritableChunk;
  options?: LiminaFlowOutputOptions;
}
