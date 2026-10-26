import {
  emitFlow,
  formatReporterFailure,
  redrawInteractiveHistory,
  replaceInteractiveHistoryLine,
} from './rendering';
import { isSendProcessSnapshot } from './state';
import {
  resumeInteractiveRendering,
  suspendInteractiveRendering,
} from './suspension';
import {
  beginTerminalTracking,
  clearInteractiveTaskBlock,
  endTerminalTracking,
} from './tracking';
import type {
  FlowReporterState,
  InteractiveEntryReference,
  LiminaFlowFailureOptions,
  LiminaFlowMessageOptions,
  LiminaFlowTask,
} from './types';

interface FlowTaskState {
  completed: boolean;
  depth: number;
  message: string;
  paused: boolean;
  persistedStart: InteractiveEntryReference | undefined;
  processTransientTaskId: number | undefined;
  shouldTrack: boolean;
  startLine: number;
  startTime: number;
}

function getTaskDepth(options: LiminaFlowMessageOptions): number {
  return options.depth === undefined ? 0 : options.depth;
}

function isGetCollapseOnSuccess(
  state: FlowReporterState,
  options: LiminaFlowMessageOptions,
): boolean {
  return (
    !state.statusOnly &&
    (options.collapseOnSuccess === undefined || options.collapseOnSuccess)
  );
}

function shouldTrackTask(options: {
  state: FlowReporterState;
  taskOptions: LiminaFlowMessageOptions;
}): boolean {
  return (
    options.state.interactive &&
    isGetCollapseOnSuccess(options.state, options.taskOptions)
  );
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
    paused: false,
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
  return (
    !options.taskState.shouldTrack &&
    options.reporterState.trackedTaskCount === 0
  );
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
  return options.messageOptions?.depth === undefined
    ? options.taskState.depth + 1
    : options.messageOptions.depth;
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

async function pauseTask(options: {
  reporterState: FlowReporterState;
  taskState: FlowTaskState;
}): Promise<void> {
  if (options.taskState.completed || options.taskState.paused) return;
  options.taskState.paused = true;
  await suspendInteractiveRendering(options.reporterState);
}

function resumeTask(options: {
  reporterState: FlowReporterState;
  taskState: FlowTaskState;
}): void {
  if (options.taskState.completed || !options.taskState.paused) return;
  options.taskState.paused = false;
  resumeInteractiveRendering(options.reporterState);
}

type FinishedTaskStatus = 'fail' | 'pass' | 'skip';

function getElapsedTime(options: {
  finishOptions: LiminaFlowMessageOptions | undefined;
  startTime: number;
}): number {
  return options.finishOptions?.elapsedTimeMs === undefined
    ? performance.now() - options.startTime
    : options.finishOptions.elapsedTimeMs;
}

function createTaskFinishOptions<T extends LiminaFlowMessageOptions>(options: {
  depth: number;
  finishOptions: T | undefined;
  startTime: number;
}): T & Required<Pick<LiminaFlowMessageOptions, 'depth' | 'elapsedTimeMs'>> {
  return {
    ...options.finishOptions,
    depth: options.depth,
    elapsedTimeMs: getElapsedTime(options),
  } as T & Required<Pick<LiminaFlowMessageOptions, 'depth' | 'elapsedTimeMs'>>;
}

function finishTrackedTask(options: {
  reporterState: FlowReporterState;
  taskState: FlowTaskState;
}): void {
  if (!options.taskState.shouldTrack || options.taskState.completed) return;
  options.taskState.completed = true;
  endTerminalTracking(options.reporterState);
}

function canReplacePersistedStart(options: {
  reporterState: FlowReporterState;
  taskState: FlowTaskState;
}): boolean {
  return (
    !options.taskState.shouldTrack &&
    options.reporterState.interactive &&
    options.taskState.persistedStart !== undefined
  );
}

function replaceStart(options: {
  message: string;
  reporterState: FlowReporterState;
  status: FinishedTaskStatus;
  taskOptions: LiminaFlowMessageOptions;
  taskState: FlowTaskState;
}): void {
  const reference = options.taskState.persistedStart;
  if (reference === undefined) return;
  replaceInteractiveHistoryLine({
    message: options.message,
    reference,
    state: options.reporterState,
    status: options.status,
    taskOptions: options.taskOptions,
  });
  redrawInteractiveHistory(options.reporterState);
}

function emitCompletedTask(options: {
  message: string;
  persistInteractive: boolean;
  reporterState: FlowReporterState;
  status: FinishedTaskStatus;
  taskOptions: LiminaFlowMessageOptions;
  taskState: FlowTaskState;
}): void {
  if (canReplacePersistedStart(options)) {
    replaceStart(options);
  } else {
    emitFlow(options.reporterState, {
      meta: { persistInteractive: options.persistInteractive },
      options: options.taskOptions,
      rawMessage: options.message,
      status: options.status,
    });
  }
  finishTrackedTask(options);
  options.taskState.completed = true;
}

function resolveTaskMessage(
  message: string | undefined,
  fallback: string,
): string {
  return message === undefined ? fallback : message;
}

function resolveFailureMessage(options: {
  finishOptions: LiminaFlowFailureOptions | undefined;
  message: string | undefined;
  reporterState: FlowReporterState;
  taskState: FlowTaskState;
}): string {
  const baseMessage = options.reporterState.statusOnly
    ? options.taskState.message
    : resolveTaskMessage(options.message, options.taskState.message);
  return formatReporterFailure({
    message: baseMessage,
    options: options.finishOptions,
    state: options.reporterState,
  });
}

function finishFailure(options: {
  finishOptions: LiminaFlowFailureOptions | undefined;
  message: string | undefined;
  reporterState: FlowReporterState;
  taskState: FlowTaskState;
}): void {
  const taskOptions = createTaskFinishOptions({
    depth: options.taskState.depth,
    finishOptions: options.finishOptions,
    startTime: options.taskState.startTime,
  });
  emitCompletedTask({
    message: resolveFailureMessage(options),
    persistInteractive: true,
    reporterState: options.reporterState,
    status: 'fail',
    taskOptions,
    taskState: options.taskState,
  });
}

function shouldPersistPass(options: {
  reporterState: FlowReporterState;
  taskState: FlowTaskState;
}): boolean {
  return options.taskState.shouldTrack
    ? options.reporterState.trackedTaskCount <= 1
    : options.reporterState.trackedTaskCount === 0;
}

function removeTransientTask(options: {
  reporterState: FlowReporterState;
  taskState: FlowTaskState;
}): void {
  options.reporterState.processTransientHistory =
    options.reporterState.processTransientHistory.filter(
      (entry) => entry.taskId !== options.taskState.processTransientTaskId,
    );
  isSendProcessSnapshot(options.reporterState);
}

function shouldRedrawCollapsedHistory(options: {
  persistInteractive: boolean;
  taskState: FlowTaskState;
}): boolean {
  return options.persistInteractive && options.taskState.depth === 0;
}

function hasActiveProcessRenderer(state: FlowReporterState): boolean {
  return state.processRenderer?.active === true;
}

function clearTrackedPass(options: {
  persistInteractive: boolean;
  reporterState: FlowReporterState;
  taskState: FlowTaskState;
}): void {
  if (!options.taskState.shouldTrack) return;
  if (hasActiveProcessRenderer(options.reporterState)) {
    removeTransientTask(options);
    return;
  }
  clearInteractiveTaskBlock({
    redrawHistory: shouldRedrawCollapsedHistory(options),
    startLine: options.taskState.startLine,
    state: options.reporterState,
  });
}

function finishPass(options: {
  finishOptions: LiminaFlowMessageOptions | undefined;
  message: string | undefined;
  reporterState: FlowReporterState;
  taskState: FlowTaskState;
}): void {
  const taskOptions = createTaskFinishOptions({
    depth: options.taskState.depth,
    finishOptions: options.finishOptions,
    startTime: options.taskState.startTime,
  });
  const isPersistInteractive = shouldPersistPass(options);
  clearTrackedPass({ ...options, persistInteractive: isPersistInteractive });
  emitCompletedTask({
    message: resolveTaskMessage(options.message, options.taskState.message),
    persistInteractive: isPersistInteractive,
    reporterState: options.reporterState,
    status: 'pass',
    taskOptions,
    taskState: options.taskState,
  });
}

function finishSkip(options: {
  finishOptions: LiminaFlowMessageOptions | undefined;
  message: string | undefined;
  reporterState: FlowReporterState;
  taskState: FlowTaskState;
}): void {
  const taskOptions = createTaskFinishOptions({
    depth: options.taskState.depth,
    finishOptions: options.finishOptions,
    startTime: options.taskState.startTime,
  });
  emitCompletedTask({
    message: resolveTaskMessage(options.message, options.taskState.message),
    persistInteractive: options.reporterState.trackedTaskCount === 0,
    reporterState: options.reporterState,
    status: 'skip',
    taskOptions,
    taskState: options.taskState,
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
    pause: () =>
      pauseTask({
        reporterState: options.reporterState,
        taskState,
      }),
    pass: (message, finishOptions) =>
      finishPass({
        finishOptions,
        message,
        reporterState: options.reporterState,
        taskState,
      }),
    resume: () =>
      resumeTask({
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
