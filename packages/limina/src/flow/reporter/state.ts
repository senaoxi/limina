import * as prompts from '@clack/prompts';
import { isSupportsInteractiveTerminal } from '../../terminal-environment';
import {
  isIntegerNumber,
  parseIntegerPrefix,
} from '../../utils/validation/is-integer';
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

const FLOW_RENDERER_TEST_ROWS_ENV = 'LIMINA_FLOW_RENDERER_TEST_ROWS';

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
  return (
    options.interactive &&
    options.reporterOptions.renderer !== 'inline' &&
    !hasInjectedRendererDependency(options.reporterOptions)
  );
}

function createProcessRenderer(options: {
  interactive: boolean;
  reporterOptions: LiminaFlowReporterOptions;
}): FlowProcessRenderer | undefined {
  return shouldCreateProcessRenderer(options)
    ? FlowProcessRenderer.start()
    : undefined;
}

function isUnrenderedInteractive(options: {
  interactive: boolean;
  processRenderer: FlowProcessRenderer | undefined;
}): boolean {
  return options.interactive && options.processRenderer === undefined;
}

function shouldTrackProcessWrites(options: {
  interactive: boolean;
  outputInjected: boolean;
  processRenderer: FlowProcessRenderer | undefined;
  statusOnly: boolean;
}): boolean {
  return (
    !(options.statusOnly || options.outputInjected) &&
    isUnrenderedInteractive(options)
  );
}

function toPositiveInteger(parsed: number): number | undefined {
  if (!isIntegerNumber(parsed)) return undefined;
  return parsed <= 0 ? undefined : parsed;
}

export function readPositiveInteger(
  value: string | undefined,
): number | undefined {
  return value === undefined
    ? undefined
    : toPositiveInteger(parseIntegerPrefix(value));
}

function resolveEnvironment(
  options: LiminaFlowReporterOptions,
): NodeJS.ProcessEnv {
  return options.env === undefined ? process.env : options.env;
}

function resolveStdout(options: LiminaFlowReporterOptions): FlowWriteStream {
  return options.stdout === undefined ? process.stdout : options.stdout;
}

function resolveStderr(options: LiminaFlowReporterOptions): FlowWriteStream {
  return options.stderr === undefined ? process.stderr : options.stderr;
}

function isInteger(value: number | undefined): value is number {
  return isIntegerNumber(value);
}

function resolveReservedTopRows(value: number | undefined): number {
  return isInteger(value) ? Math.max(0, value) : 0;
}

function isResolveInteractive(options: {
  env: NodeJS.ProcessEnv;
  reporterOptions: LiminaFlowReporterOptions;
  stdout: FlowWriteStream;
}): boolean {
  return options.reporterOptions.forceTty === undefined
    ? isSupportsInteractiveTerminal(options.env, options.stdout)
    : options.reporterOptions.forceTty;
}

function resolveOutput(options: {
  reporterOptions: LiminaFlowReporterOptions;
  stdout: FlowWriteStream;
}): FlowOutput {
  return options.reporterOptions.output === undefined
    ? createDefaultOutput(options.stdout)
    : options.reporterOptions.output;
}

function resolveClack(options: LiminaFlowReporterOptions) {
  return options.clack === undefined ? prompts : options.clack;
}

export function createFlowReporterState(options: {
  reporterOptions: LiminaFlowReporterOptions;
  statusOnly: boolean;
}): FlowReporterState {
  const environment = resolveEnvironment(options.reporterOptions);
  const stdout = resolveStdout(options.reporterOptions);
  const isInteractive = isResolveInteractive({
    env: environment,
    reporterOptions: options.reporterOptions,
    stdout,
  });
  const processRenderer = createProcessRenderer({
    interactive: isInteractive,
    reporterOptions: options.reporterOptions,
  });
  return {
    clack: resolveClack(options.reporterOptions),
    env: environment,
    hasInteractiveTree: false,
    interactive: isInteractive,
    interactiveHistory: [],
    nextProcessTransientEntryId: 0,
    nextProcessTransientTaskId: 0,
    outroMessage: undefined,
    output: resolveOutput({ reporterOptions: options.reporterOptions, stdout }),
    processRenderer,
    processTransientHistory: [],
    reservedTopRows: resolveReservedTopRows(
      options.reporterOptions.reservedTopRows,
    ),
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
      interactive: isInteractive,
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

function getPhysicalTerminalRows(state: FlowReporterState): number | undefined {
  const testRows = readPositiveInteger(state.env[FLOW_RENDERER_TEST_ROWS_ENV]);
  return testRows === undefined ? state.stdout?.rows : testRows;
}

function getTerminalRows(state: FlowReporterState): number | undefined {
  const rows = getPhysicalTerminalRows(state);

  return rows === undefined
    ? undefined
    : Math.max(1, rows - state.reservedTopRows);
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
  return dimensions.columns === undefined && dimensions.rows === undefined
    ? {}
    : { terminalDimensions: dimensions };
}

function getCompactModeField(isStatusOnly: boolean): {
  compactMode?: 'check-flow';
} {
  return isStatusOnly ? { compactMode: 'check-flow' } : {};
}

function getOutroField(message: string | undefined): { outroMessage?: string } {
  return message === undefined ? {} : { outroMessage: message };
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

export function isSendProcessSnapshot(state: FlowReporterState): boolean {
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
