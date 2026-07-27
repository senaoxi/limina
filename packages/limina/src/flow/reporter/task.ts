import { emitFlow } from './rendering';
import { finishFailure, finishPass, finishSkip } from './task-finish';
import type { FlowTaskState } from './task-types';
import { beginTerminalTracking } from './tracking';
import type {
  FlowReporterState,
  LiminaFlowMessageOptions,
  LiminaFlowTask,
} from './types';

function getTaskDepth(options: LiminaFlowMessageOptions): number {
  if (options.depth === undefined) return 0;
  return options.depth;
}

function getCollapseOnSuccess(
  state: FlowReporterState,
  options: LiminaFlowMessageOptions,
): boolean {
  if (state.statusOnly) return false;
  if (options.collapseOnSuccess === undefined) return true;
  return options.collapseOnSuccess;
}

function shouldTrackTask(options: {
  state: FlowReporterState;
  taskOptions: LiminaFlowMessageOptions;
}): boolean {
  if (!options.state.interactive) return false;
  return getCollapseOnSuccess(options.state, options.taskOptions);
}

function reserveTransientTaskId(options: {
  shouldTrack: boolean;
  state: FlowReporterState;
}): number | undefined {
  if (!options.shouldTrack) return undefined;
  if (options.state.processRenderer === undefined) return undefined;
  const id = options.state.nextProcessTransientTaskId;
  options.state.nextProcessTransientTaskId += 1;
  return id;
}

function createFlowTaskState(options: {
  message: string;
  state: FlowReporterState;
  taskOptions: LiminaFlowMessageOptions;
}): FlowTaskState {
  const shouldTrack = shouldTrackTask(options);
  return {
    completed: false,
    depth: getTaskDepth(options.taskOptions),
    message: options.message,
    persistedStart: undefined,
    processTransientTaskId: reserveTransientTaskId({
      shouldTrack,
      state: options.state,
    }),
    shouldTrack,
    startLine: options.state.terminalFrame.lineCount,
    startTime: performance.now(),
  };
}

function shouldPersistStart(options: {
  reporterState: FlowReporterState;
  taskState: FlowTaskState;
}): boolean {
  if (options.taskState.shouldTrack) return false;
  return options.reporterState.trackedTaskCount === 0;
}

function startFlowTask(options: {
  message: string;
  reporterState: FlowReporterState;
  taskOptions: LiminaFlowMessageOptions;
  taskState: FlowTaskState;
}): void {
  if (options.taskState.shouldTrack) {
    beginTerminalTracking(options.reporterState);
  }
  options.taskState.persistedStart = emitFlow(options.reporterState, {
    meta: {
      persistInteractive: shouldPersistStart(options),
      transientTaskId: options.taskState.processTransientTaskId,
    },
    options: options.taskOptions,
    rawMessage: options.message,
    status: 'start',
  });
}

function getNestedDepth(options: {
  messageOptions: LiminaFlowMessageOptions | undefined;
  taskState: FlowTaskState;
}): number {
  if (options.messageOptions?.depth !== undefined) {
    return options.messageOptions.depth;
  }
  return options.taskState.depth + 1;
}

function emitNestedStatus(options: {
  message: string;
  messageOptions: LiminaFlowMessageOptions | undefined;
  reporterState: FlowReporterState;
  status: 'info' | 'warn';
  taskState: FlowTaskState;
}): void {
  emitFlow(options.reporterState, {
    options: {
      ...options.messageOptions,
      depth: getNestedDepth(options),
    },
    rawMessage: options.message,
    status: options.status,
  });
}

export function createFlowTask(options: {
  message: string;
  reporterState: FlowReporterState;
  taskOptions: LiminaFlowMessageOptions;
}): LiminaFlowTask {
  const taskState = createFlowTaskState({
    message: options.message,
    state: options.reporterState,
    taskOptions: options.taskOptions,
  });
  startFlowTask({ ...options, taskState });
  return {
    fail: (message, finishOptions) =>
      finishFailure({
        finishOptions,
        message,
        reporterState: options.reporterState,
        taskState,
      }),
    info: (message, messageOptions) =>
      emitNestedStatus({
        message,
        messageOptions,
        reporterState: options.reporterState,
        status: 'info',
        taskState,
      }),
    pass: (message, finishOptions) =>
      finishPass({
        finishOptions,
        message,
        reporterState: options.reporterState,
        taskState,
      }),
    skip: (message, finishOptions) =>
      finishSkip({
        finishOptions,
        message,
        reporterState: options.reporterState,
        taskState,
      }),
    warn: (message, messageOptions) =>
      emitNestedStatus({
        message,
        messageOptions,
        reporterState: options.reporterState,
        status: 'warn',
        taskState,
      }),
  };
}
