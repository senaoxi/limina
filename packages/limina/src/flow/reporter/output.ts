import { type FlowWritableChunk, toWritableText } from '../render-model';
import type { FlowWriteStream } from '../terminal-frame';
import { redrawInteractiveHistory, writeTracked } from './rendering';
import { isSendProcessSnapshot } from './state';
import type { FlowReporterState, LiminaFlowOutputOptions } from './types';

function writeLine(state: FlowReporterState, message: string): void {
  state.output.write(`${message}\n`);
}

function addIntroHistory(state: FlowReporterState, message: string): void {
  state.interactiveHistory.push({ kind: 'line', line: `┌  ${message}` });
}

function isReportProcessIntro(
  state: FlowReporterState,
  message: string,
): boolean {
  if (state.processRenderer?.active !== true) return false;
  addIntroHistory(state, message);
  isSendProcessSnapshot(state);
  return true;
}

export function reportIntro(state: FlowReporterState, message: string): void {
  if (!state.interactive) {
    writeLine(state, `[start] ${message}`);
    return;
  }
  if (isReportProcessIntro(state, message)) return;
  addIntroHistory(state, message);
  state.clack.intro(message);
  state.terminalFrame.record(`${message}\n`);
}

function isReportProcessOutro(
  state: FlowReporterState,
  message: string,
): boolean {
  if (state.processRenderer?.active !== true) return false;
  state.outroMessage = message;
  isSendProcessSnapshot(state);
  return true;
}

function reportInteractiveOutro(
  state: FlowReporterState,
  message: string,
): void {
  if (isReportProcessOutro(state, message)) return;
  if (state.statusOnly) {
    state.outroMessage = message;
    redrawInteractiveHistory(state);
    return;
  }
  state.clack.outro(message);
}

export function reportOutro(state: FlowReporterState, message: string): void {
  if (state.interactive) {
    reportInteractiveOutro(state, message);
    return;
  }
  writeLine(state, `[done] ${message}`);
}

function selectOutputStream(
  state: FlowReporterState,
  options: LiminaFlowOutputOptions,
): FlowWriteStream | undefined {
  return options.stream === 'stderr' ? state.stderr : state.stdout;
}

function getInteractiveOutputStream(options: {
  outputOptions: LiminaFlowOutputOptions;
  state: FlowReporterState;
}): FlowWriteStream | undefined {
  if (!options.state.interactive) return undefined;
  return options.state.tracksProcessWrites
    ? selectOutputStream(options.state, options.outputOptions)
    : undefined;
}

function recordUnpatchedWrite(
  state: FlowReporterState,
  message: FlowWritableChunk,
): void {
  if (state.restoreWriteStreams !== undefined) return;
  state.terminalFrame.record(message);
}

function isWriteInteractiveOutput(options: {
  message: FlowWritableChunk;
  outputOptions: LiminaFlowOutputOptions;
  state: FlowReporterState;
}): boolean {
  const stream = getInteractiveOutputStream(options);
  if (typeof stream?.write !== 'function') return false;
  recordUnpatchedWrite(options.state, options.message);
  stream.write(options.message);
  return true;
}

function isWriteProcessOutput(options: {
  message: FlowWritableChunk;
  outputOptions: LiminaFlowOutputOptions;
  state: FlowReporterState;
}): boolean {
  if (options.state.processRenderer?.active !== true) return false;
  options.state.processRenderer.writeOutput({
    stream: options.outputOptions.stream,
    text: toWritableText(options.message),
  });
  return true;
}

function writeActiveReporterOutput(options: {
  message: FlowWritableChunk;
  outputOptions: LiminaFlowOutputOptions;
  state: FlowReporterState;
}): void {
  if (isWriteProcessOutput(options) || isWriteInteractiveOutput(options))
    return;
  writeTracked({
    message: toWritableText(options.message),
    state: options.state,
  });
}

export function writeReporterOutput(options: {
  message: FlowWritableChunk;
  outputOptions: LiminaFlowOutputOptions;
  state: FlowReporterState;
}): void {
  if (options.state.statusOnly) return;
  writeActiveReporterOutput(options);
}
