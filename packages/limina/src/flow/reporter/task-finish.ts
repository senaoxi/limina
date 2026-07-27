import {
  emitFlow,
  formatReporterFailure,
  redrawInteractiveHistory,
  replaceInteractiveHistoryLine,
} from './rendering';
import { sendProcessSnapshot } from './state';
import type { FlowTaskState } from './task-types';
import { clearInteractiveTaskBlock, endTerminalTracking } from './tracking';
import type {
  FlowReporterState,
  LiminaFlowFailureOptions,
  LiminaFlowMessageOptions,
} from './types';

type FinishedTaskStatus = 'fail' | 'pass' | 'skip';

function getElapsedTime(options: {
  finishOptions: LiminaFlowMessageOptions | undefined;
  startTime: number;
}): number {
  if (options.finishOptions?.elapsedTimeMs !== undefined) {
    return options.finishOptions.elapsedTimeMs;
  }
  return performance.now() - options.startTime;
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
  if (!options.taskState.shouldTrack) return;
  if (options.taskState.completed) return;
  options.taskState.completed = true;
  endTerminalTracking(options.reporterState);
}

function canReplacePersistedStart(options: {
  reporterState: FlowReporterState;
  taskState: FlowTaskState;
}): boolean {
  if (options.taskState.shouldTrack) return false;
  if (!options.reporterState.interactive) return false;
  return options.taskState.persistedStart !== undefined;
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
}

function resolveTaskMessage(
  message: string | undefined,
  fallback: string,
): string {
  if (message === undefined) return fallback;
  return message;
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

export function finishFailure(options: {
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
  if (options.taskState.shouldTrack) {
    return options.reporterState.trackedTaskCount <= 1;
  }
  return options.reporterState.trackedTaskCount === 0;
}

function removeTransientTask(options: {
  reporterState: FlowReporterState;
  taskState: FlowTaskState;
}): void {
  options.reporterState.processTransientHistory =
    options.reporterState.processTransientHistory.filter(
      (entry) => entry.taskId !== options.taskState.processTransientTaskId,
    );
  sendProcessSnapshot(options.reporterState);
}

function shouldRedrawCollapsedHistory(options: {
  persistInteractive: boolean;
  taskState: FlowTaskState;
}): boolean {
  if (!options.persistInteractive) return false;
  return options.taskState.depth === 0;
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

export function finishPass(options: {
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
  const persistInteractive = shouldPersistPass(options);
  clearTrackedPass({ ...options, persistInteractive });
  emitCompletedTask({
    message: resolveTaskMessage(options.message, options.taskState.message),
    persistInteractive,
    reporterState: options.reporterState,
    status: 'pass',
    taskOptions,
    taskState: options.taskState,
  });
}

export function finishSkip(options: {
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
