import * as prompts from '@clack/prompts';
import { FlowProcessRenderer } from '../process-renderer';
import {
  type FlowRenderSnapshot,
  type FlowTerminalDimensions,
  renderSnapshotLinesForTerminal,
} from '../render-model';
import {
  DEFAULT_TERMINAL_COLUMNS,
  type FlowWriteStream,
  TerminalFrameTracker,
} from '../terminal-frame';
import { cloneFlowTreeNode } from '../tree-state';
import type {
  FlowOutput,
  FlowReporterState,
  LiminaFlowReporterOptions,
} from './types';

const DEFAULT_CI_ENV_VALUES = new Set(['1', 'true']);
const FLOW_RENDERER_TEST_ROWS_ENV = 'LIMINA_FLOW_RENDERER_TEST_ROWS';

function isEnabledCiValue(value: string | undefined): boolean {
  return DEFAULT_CI_ENV_VALUES.has(String(value).toLowerCase());
}

function isCiEnvironment(env: NodeJS.ProcessEnv): boolean {
  return isEnabledCiValue(env.CI) || isEnabledCiValue(env.CODEX_CI);
}

function supportsInteractiveTerminal(
  env: NodeJS.ProcessEnv,
  stdout: FlowWriteStream,
): boolean {
  if (!stdout.isTTY) return false;
  if (isCiEnvironment(env)) return false;
  return String(env.TERM).toLowerCase() !== 'dumb';
}

function createDefaultOutput(stdout: FlowWriteStream): FlowOutput {
  return {
    write: (message) => {
      if (typeof stdout.write === 'function') {
        (stdout.write as (message: string) => boolean)(message);
        return;
      }
      process.stdout.write(message);
    },
  };
}

function hasInjectedRendererDependency(
  options: LiminaFlowReporterOptions,
): boolean {
  return [options.output, options.stdout, options.stderr, options.clack].some(
    (value) => value !== undefined,
  );
}

function shouldCreateProcessRenderer(options: {
  interactive: boolean;
  reporterOptions: LiminaFlowReporterOptions;
}): boolean {
  if (!options.interactive) return false;
  if (options.reporterOptions.renderer === 'inline') return false;
  return !hasInjectedRendererDependency(options.reporterOptions);
}

function createProcessRenderer(options: {
  interactive: boolean;
  reporterOptions: LiminaFlowReporterOptions;
}): FlowProcessRenderer | undefined {
  if (!shouldCreateProcessRenderer(options)) return undefined;
  return FlowProcessRenderer.start();
}

function isUnrenderedInteractive(options: {
  interactive: boolean;
  processRenderer: FlowProcessRenderer | undefined;
}): boolean {
  if (!options.interactive) return false;
  return options.processRenderer === undefined;
}

function shouldTrackProcessWrites(options: {
  interactive: boolean;
  outputInjected: boolean;
  processRenderer: FlowProcessRenderer | undefined;
  statusOnly: boolean;
}): boolean {
  if (options.statusOnly) return false;
  if (options.outputInjected) return false;
  return isUnrenderedInteractive(options);
}

function toPositiveInteger(parsed: number): number | undefined {
  if (!Number.isInteger(parsed)) return undefined;
  if (parsed <= 0) return undefined;
  return parsed;
}

export function readPositiveInteger(
  value: string | undefined,
): number | undefined {
  if (value === undefined) return undefined;
  return toPositiveInteger(Number.parseInt(value, 10));
}

function resolveEnvironment(
  options: LiminaFlowReporterOptions,
): NodeJS.ProcessEnv {
  if (options.env !== undefined) return options.env;
  return process.env;
}

function resolveStdout(options: LiminaFlowReporterOptions): FlowWriteStream {
  if (options.stdout !== undefined) return options.stdout;
  return process.stdout;
}

function resolveStderr(options: LiminaFlowReporterOptions): FlowWriteStream {
  if (options.stderr !== undefined) return options.stderr;
  return process.stderr;
}

function resolveInteractive(options: {
  env: NodeJS.ProcessEnv;
  reporterOptions: LiminaFlowReporterOptions;
  stdout: FlowWriteStream;
}): boolean {
  if (options.reporterOptions.forceTty !== undefined) {
    return options.reporterOptions.forceTty;
  }
  return supportsInteractiveTerminal(options.env, options.stdout);
}

function resolveOutput(options: {
  reporterOptions: LiminaFlowReporterOptions;
  stdout: FlowWriteStream;
}): FlowOutput {
  if (options.reporterOptions.output !== undefined) {
    return options.reporterOptions.output;
  }
  return createDefaultOutput(options.stdout);
}

function resolveClack(options: LiminaFlowReporterOptions) {
  if (options.clack !== undefined) return options.clack;
  return prompts;
}

export function createFlowReporterState(options: {
  reporterOptions: LiminaFlowReporterOptions;
  statusOnly: boolean;
}): FlowReporterState {
  const env = resolveEnvironment(options.reporterOptions);
  const stdout = resolveStdout(options.reporterOptions);
  const interactive = resolveInteractive({
    env,
    reporterOptions: options.reporterOptions,
    stdout,
  });
  const processRenderer = createProcessRenderer({
    interactive,
    reporterOptions: options.reporterOptions,
  });
  return {
    clack: resolveClack(options.reporterOptions),
    env,
    hasInteractiveTree: false,
    interactive,
    interactiveHistory: [],
    nextProcessTransientEntryId: 0,
    nextProcessTransientTaskId: 0,
    outroMessage: undefined,
    output: resolveOutput({ reporterOptions: options.reporterOptions, stdout }),
    processRenderer,
    processTransientHistory: [],
    restoreWriteStreams: undefined,
    spinnerFrameIndex: 0,
    spinnerTimer: undefined,
    statusOnly: options.statusOnly,
    stderr: resolveStderr(options.reporterOptions),
    stdout,
    terminalFrame: new TerminalFrameTracker(
      () => stdout.columns ?? DEFAULT_TERMINAL_COLUMNS,
    ),
    trackedTaskCount: 0,
    tracksProcessWrites: shouldTrackProcessWrites({
      interactive,
      outputInjected: options.reporterOptions.output !== undefined,
      processRenderer,
      statusOnly: options.statusOnly,
    }),
    treeRoots: [],
  };
}

function getTerminalColumns(state: FlowReporterState): number | undefined {
  return state.stdout?.columns;
}

function getTerminalRows(state: FlowReporterState): number | undefined {
  const testRows = readPositiveInteger(state.env[FLOW_RENDERER_TEST_ROWS_ENV]);
  if (testRows !== undefined) return testRows;
  return state.stdout?.rows;
}

export function getTerminalDimensions(
  state: FlowReporterState,
): FlowTerminalDimensions {
  return {
    columns: getTerminalColumns(state),
    rows: getTerminalRows(state),
  };
}

function getTerminalDimensionField(dimensions: FlowTerminalDimensions): {
  terminalDimensions?: FlowTerminalDimensions;
} {
  if (dimensions.columns === undefined && dimensions.rows === undefined)
    return {};
  return { terminalDimensions: dimensions };
}

function getCompactModeField(statusOnly: boolean): {
  compactMode?: 'check-flow';
} {
  if (!statusOnly) return {};
  return { compactMode: 'check-flow' };
}

function getOutroField(message: string | undefined): { outroMessage?: string } {
  if (message === undefined) return {};
  return { outroMessage: message };
}

export function createRenderSnapshot(
  state: FlowReporterState,
): FlowRenderSnapshot {
  const dimensions = getTerminalDimensions(state);
  return {
    ...getCompactModeField(state.statusOnly),
    entries: [
      ...state.interactiveHistory,
      ...state.processTransientHistory.map(({ entry }) => entry),
    ],
    ...getOutroField(state.outroMessage),
    ...getTerminalDimensionField(dimensions),
    treeRoots: state.treeRoots.map(cloneFlowTreeNode),
  };
}

export function sendProcessSnapshot(state: FlowReporterState): boolean {
  if (state.processRenderer?.active !== true) return false;
  state.processRenderer.sendSnapshot(createRenderSnapshot(state));
  return true;
}

export function writeRenderSnapshotInline(
  state: FlowReporterState,
  snapshot: FlowRenderSnapshot,
): void {
  const lines = renderSnapshotLinesForTerminal(
    snapshot,
    state.spinnerFrameIndex,
    getTerminalDimensions(state),
  );
  for (const line of lines) state.output.write(`${line}\n`);
}
