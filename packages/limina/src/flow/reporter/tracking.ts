import type { FlowWritableChunk } from '../render-model';
import { patchWriteStream } from '../terminal-frame';
import { redrawInteractiveHistory, writeControl } from './rendering';
import type { FlowReporterState } from './types';

function recordProcessWrite(
  state: FlowReporterState,
  chunk: FlowWritableChunk,
): void {
  state.terminalFrame.record(chunk);
}

function createRestoreOperation(state: FlowReporterState): () => void {
  const restoreStdout = patchWriteStream(state.stdout, (chunk) =>
    recordProcessWrite(state, chunk),
  );
  const restoreStderr = patchWriteStream(state.stderr, (chunk) =>
    recordProcessWrite(state, chunk),
  );
  return () => {
    restoreStdout?.();
    restoreStderr?.();
    state.restoreWriteStreams = undefined;
  };
}

export function beginTerminalTracking(state: FlowReporterState): void {
  state.trackedTaskCount += 1;
  if (state.trackedTaskCount > 1) return;
  if (!state.tracksProcessWrites) return;
  state.restoreWriteStreams = createRestoreOperation(state);
}

export function endTerminalTracking(state: FlowReporterState): void {
  state.trackedTaskCount = Math.max(0, state.trackedTaskCount - 1);
  if (state.trackedTaskCount !== 0) return;
  state.restoreWriteStreams?.();
}

export function clearInteractiveTaskBlock(options: {
  redrawHistory?: boolean;
  startLine: number;
  state: FlowReporterState;
}): void {
  const linesToClear =
    options.state.terminalFrame.lineCount - options.startLine;
  if (linesToClear <= 0) return;
  if (options.redrawHistory === true) {
    redrawInteractiveHistory(options.state);
    return;
  }
  writeControl(options.state, `\r\u001B[${linesToClear}A\u001B[J`);
  options.state.terminalFrame.setLineCount(options.startLine);
}
