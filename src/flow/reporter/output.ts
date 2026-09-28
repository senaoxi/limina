import { type FlowWritableChunk, toWritableText } from '../render-model';
import type { FlowWriteStream } from '../terminal-frame';
import { redrawInteractiveHistory, writeTracked } from './rendering';
import { sendProcessSnapshot } from './state';
import type { FlowReporterState, LiminaFlowOutputOptions } from './types';

function writeLine(state: FlowReporterState, message: string): void {
  state.output.write(`${message}\n`);
}

function addIntroHistory(state: FlowReporterState, message: string): void {
  state.interactiveHistory.push({ kind: 'line', line: `┌  ${message}` });
}

function reportProcessIntro(
  state: FlowReporterState,
  message: string,
): boolean {
  if (state.processRenderer?.active !== true) return false;
  addIntroHistory(state, message);
  sendProcessSnapshot(state);
  return true;
}

export function reportIntro(state: FlowReporterState, message: string): void {
  if (!state.interactive) {
    writeLine(state, `[start] ${message}`);
    return;
  }
  if (reportProcessIntro(state, message)) return;
  addIntroHistory(state, message);
  state.clack.intro(message);
  state.terminalFrame.record(`${message}\n`);
}

function reportProcessOutro(
  state: FlowReporterState,
  message: string,
): boolean {
  if (state.processRenderer?.active !== true) return false;
  state.outroMessage = message;
  sendProcessSnapshot(state);
  return true;
}

function reportInteractiveOutro(
  state: FlowReporterState,
  message: string,
): void {
  if (reportProcessOutro(state, message)) return;
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
  if (options.stream === 'stderr') return state.stderr;
  return state.stdout;
}

function getInteractiveOutputStream(options: {
  outputOptions: LiminaFlowOutputOptions;
  state: FlowReporterState;
}): FlowWriteStream | undefined {
  if (!options.state.interactive) return undefined;
  if (!options.state.tracksProcessWrites) return undefined;
  return selectOutputStream(options.state, options.outputOptions);
}

function recordUnpatchedWrite(
  state: FlowReporterState,
  message: FlowWritableChunk,
): void {
  if (state.restoreWriteStreams !== undefined) return;
  state.terminalFrame.record(message);
}

function writeInteractiveOutput(options: {
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

function writeProcessOutput(options: {
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
  if (writeProcessOutput(options)) return;
  if (writeInteractiveOutput(options)) return;
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
