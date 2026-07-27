import { formatErrorMessage } from 'logaria/helper';
import {
  type FlowRenderFlowLine,
  type FlowStatus,
  formatInteractiveLine,
  formatMessageWithElapsed,
  hasRunningSnapshotWork,
  renderSnapshotLinesForTerminal,
  SPINNER_FRAMES,
  SPINNER_INTERVAL_MS,
} from '../render-model';
import {
  createRenderSnapshot,
  getTerminalDimensions,
  sendProcessSnapshot,
  writeRenderSnapshotInline,
} from './state';
import type {
  FlowEmitInput,
  FlowReporterState,
  InteractiveEntryReference,
  LiminaFlowFailureOptions,
  LiminaFlowMessageOptions,
} from './types';

function normalizeErrorDetail(error: unknown): string {
  return formatErrorMessage(error).replaceAll(/\s+/gu, ' ').trim();
}

export function formatFailureMessage(message: string, error: unknown): string {
  if (error === undefined) return message;
  const detail = normalizeErrorDetail(error);
  if (detail.length === 0) return message;
  return `${message}: ${detail}`;
}

export function formatReporterFailure(options: {
  message: string;
  options: LiminaFlowFailureOptions | undefined;
  state: FlowReporterState;
}): string {
  if (options.state.statusOnly) return options.message;
  return formatFailureMessage(options.message, options.options?.error);
}

export function writeControl(state: FlowReporterState, message: string): void {
  state.output.write(message);
}

export function writeTracked(options: {
  forceRecord?: boolean;
  message: string;
  state: FlowReporterState;
}): void {
  if (options.forceRecord === true || !options.state.tracksProcessWrites) {
    options.state.terminalFrame.record(options.message);
  }
  options.state.output.write(options.message);
}

function writeRenderedLine(state: FlowReporterState, line: string): void {
  writeTracked({
    forceRecord: state.restoreWriteStreams === undefined,
    message: `${line}\n`,
    state,
  });
}

function createFlowHistoryEntry(options: {
  depth: number;
  input: FlowEmitInput;
}): FlowRenderFlowLine {
  return {
    depth: options.depth,
    elapsedTimeMs: options.input.options.elapsedTimeMs,
    kind: 'flow-line',
    message: options.input.rawMessage,
    status: options.input.status,
  };
}

function persistHistoryEntry(options: {
  entry: FlowRenderFlowLine;
  input: FlowEmitInput;
  state: FlowReporterState;
}): InteractiveEntryReference | undefined {
  if (options.input.meta?.persistInteractive !== true) return undefined;
  const reference: InteractiveEntryReference = {
    collection: 'history',
    index: options.state.interactiveHistory.length,
  };
  options.state.interactiveHistory.push(options.entry);
  return reference;
}

function persistTransientEntry(options: {
  entry: FlowRenderFlowLine;
  input: FlowEmitInput;
  state: FlowReporterState;
}): InteractiveEntryReference {
  const id = options.state.nextProcessTransientEntryId;
  options.state.nextProcessTransientEntryId += 1;
  options.state.processTransientHistory.push({
    entry: options.entry,
    id,
    taskId: options.input.meta?.transientTaskId,
  });
  return { collection: 'transient', id };
}

function emitProcessRenderedEntry(options: {
  entry: FlowRenderFlowLine;
  input: FlowEmitInput;
  reference: InteractiveEntryReference | undefined;
  state: FlowReporterState;
}): InteractiveEntryReference | undefined {
  let reference = options.reference;
  if (reference === undefined) {
    reference = persistTransientEntry(options);
  }
  sendProcessSnapshot(options.state);
  return reference;
}

function emitInteractive(options: {
  depth: number;
  input: FlowEmitInput;
  message: string;
  state: FlowReporterState;
}): InteractiveEntryReference | undefined {
  const entry = createFlowHistoryEntry({
    depth: options.depth,
    input: options.input,
  });
  const reference = persistHistoryEntry({
    entry,
    input: options.input,
    state: options.state,
  });
  if (options.state.processRenderer?.active === true) {
    return emitProcessRenderedEntry({
      entry,
      input: options.input,
      reference,
      state: options.state,
    });
  }
  writeRenderedLine(
    options.state,
    formatInteractiveLine(
      options.input.status,
      options.message,
      options.depth,
      options.state.spinnerFrameIndex,
    ),
  );
  syncSpinnerTimer(options.state);
  return reference;
}

function shouldSuppressStatus(
  state: FlowReporterState,
  status: FlowStatus,
): boolean {
  if (!state.statusOnly) return false;
  return status === 'info' || status === 'warn';
}

function getMessageDepth(options: LiminaFlowMessageOptions): number {
  if (options.depth === undefined) return 0;
  return options.depth;
}

export function emitFlow(
  state: FlowReporterState,
  input: FlowEmitInput,
): InteractiveEntryReference | undefined {
  if (shouldSuppressStatus(state, input.status)) return undefined;
  const message = formatMessageWithElapsed(
    input.rawMessage,
    input.options.elapsedTimeMs,
  );
  const depth = getMessageDepth(input.options);
  if (state.interactive) {
    return emitInteractive({ depth, input, message, state });
  }
  state.output.write(`${'  '.repeat(depth)}[${input.status}] ${message}\n`);
  return undefined;
}

function redrawFrameLines(state: FlowReporterState): void {
  const lines = renderSnapshotLinesForTerminal(
    createRenderSnapshot(state),
    state.spinnerFrameIndex,
    getTerminalDimensions(state),
  );
  for (const line of lines) writeRenderedLine(state, line);
}

export function redrawInteractiveHistory(state: FlowReporterState): void {
  if (sendProcessSnapshot(state)) return;
  if (state.terminalFrame.lineCount > 0) {
    writeControl(state, `\r\u001B[${state.terminalFrame.lineCount}A\u001B[J`);
  }
  state.terminalFrame.reset();
  redrawFrameLines(state);
}

function replaceHistoryEntry(options: {
  entry: FlowRenderFlowLine;
  reference: InteractiveEntryReference;
  state: FlowReporterState;
}): void {
  const reference = options.reference;
  if (reference.collection === 'history') {
    options.state.interactiveHistory[reference.index] = options.entry;
    return;
  }
  const transient = options.state.processTransientHistory.find(
    (candidate) => candidate.id === reference.id,
  );
  if (transient !== undefined) transient.entry = options.entry;
}

export function replaceInteractiveHistoryLine(options: {
  message: string;
  reference: InteractiveEntryReference;
  state: FlowReporterState;
  status: FlowStatus;
  taskOptions: LiminaFlowMessageOptions;
}): void {
  replaceHistoryEntry({
    entry: {
      depth: options.taskOptions.depth ?? 0,
      elapsedTimeMs: options.taskOptions.elapsedTimeMs,
      kind: 'flow-line',
      message: options.message,
      status: options.status,
    },
    reference: options.reference,
    state: options.state,
  });
  if (sendProcessSnapshot(options.state)) return;
  syncSpinnerTimer(options.state);
}

function stopSpinner(state: FlowReporterState): void {
  if (state.spinnerTimer === undefined) return;
  clearInterval(state.spinnerTimer);
  state.spinnerTimer = undefined;
}

function advanceSpinner(state: FlowReporterState): void {
  state.spinnerFrameIndex =
    (state.spinnerFrameIndex + 1) % SPINNER_FRAMES.length;
  redrawInteractiveHistory(state);
}

function shouldStopSpinner(state: FlowReporterState): boolean {
  if (!state.interactive) return true;
  return !hasRunningSnapshotWork(createRenderSnapshot(state));
}

function startSpinner(state: FlowReporterState): void {
  state.spinnerTimer = setInterval(
    () => advanceSpinner(state),
    SPINNER_INTERVAL_MS,
  );
  state.spinnerTimer.unref?.();
}

export function syncSpinnerTimer(state: FlowReporterState): void {
  if (shouldStopSpinner(state)) {
    stopSpinner(state);
    return;
  }
  if (state.spinnerTimer !== undefined) return;
  startSpinner(state);
}

export function renderTreeChange(state: FlowReporterState): void {
  if (!state.interactive) return;
  if (sendProcessSnapshot(state)) return;
  syncSpinnerTimer(state);
  redrawInteractiveHistory(state);
}

export async function closeFlowRenderer(
  state: FlowReporterState,
): Promise<void> {
  if (state.processRenderer === undefined) {
    stopSpinner(state);
    return;
  }
  const snapshot = createRenderSnapshot(state);
  const completed = await state.processRenderer.close(snapshot);
  state.processRenderer = undefined;
  if (!completed) writeRenderSnapshotInline(state, snapshot);
}
