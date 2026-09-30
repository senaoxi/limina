import {
  isIntegerNumber,
  parseIntegerPrefix,
} from '../utils/validation/is-integer';
import {
  type FlowRendererParentMessage,
  type FlowRendererProcessMessage,
  type FlowRenderSnapshot,
  hasRunningSnapshotWork,
  renderSnapshotLinesForTerminal,
  SPINNER_FRAMES,
  SPINNER_INTERVAL_MS,
} from './render-model';
import {
  DEFAULT_TERMINAL_COLUMNS,
  TerminalFrameTracker,
} from './terminal-frame';

const state = {
  snapshot: {
    entries: [],
    treeRoots: [],
  } as FlowRenderSnapshot,
  spinnerFrameIndex: 0,
  spinnerTimer: undefined as NodeJS.Timeout | undefined,
  isClosed: false,
  isSuspended: false,
};
const terminalFrame = new TerminalFrameTracker(getTerminalColumns);
const FLOW_RENDERER_TEST_COLUMNS_ENV = 'LIMINA_FLOW_RENDERER_TEST_COLUMNS';

type RendererMessageType = FlowRendererProcessMessage['type'];
type RendererMessageFor<Type extends RendererMessageType> = Extract<
  FlowRendererProcessMessage,
  { type: Type }
>;
type RendererMessageHandler = (message: FlowRendererProcessMessage) => void;

function send(message: FlowRendererParentMessage): void {
  if (typeof process.send === 'function') {
    process.send(message);
  }
}

function isPositiveInteger(value: number): boolean {
  return isIntegerNumber(value) && value > 0;
}

function readPositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = parseIntegerPrefix(value);
  return isPositiveInteger(parsed) ? parsed : undefined;
}

function firstDefinedNumber(
  values: readonly (number | undefined)[],
): number | undefined {
  return values.find((value) => value !== undefined);
}

function getTerminalColumns(): number {
  const columns = firstDefinedNumber([
    readPositiveInteger(process.env[FLOW_RENDERER_TEST_COLUMNS_ENV]),
    process.stdout.columns,
    state.snapshot.terminalDimensions?.columns,
    DEFAULT_TERMINAL_COLUMNS,
  ]);

  return Math.max(1, columns ?? DEFAULT_TERMINAL_COLUMNS);
}

function getTerminalRows(): number | undefined {
  return firstDefinedNumber([
    readPositiveInteger(process.env.LIMINA_FLOW_RENDERER_TEST_ROWS),
    process.stdout.rows,
  ]);
}

function getRenderRows(): number | undefined {
  const dimensions = state.snapshot.terminalDimensions;
  return dimensions === undefined ? getTerminalRows() : dimensions.rows;
}

function writeTracked(message: string, stream: NodeJS.WriteStream): void {
  terminalFrame.record(message);
  stream.write(message);
}

function clearRenderedFrame(): void {
  if (terminalFrame.lineCount <= 0) {
    return;
  }

  process.stdout.write(`\r\u{1B}[${terminalFrame.lineCount}A\u{1B}[J`);
  terminalFrame.reset();
}

function renderLine(line: string): void {
  writeTracked(`${line}\n`, process.stdout);
}

function render(): void {
  if (state.isSuspended) return;
  clearRenderedFrame();

  const renderedLines = renderSnapshotLinesForTerminal(
    state.snapshot,
    state.spinnerFrameIndex,
    {
      columns: getTerminalColumns(),
      rows: getRenderRows(),
    },
  );

  for (const line of renderedLines) {
    renderLine(line);
  }
}

function stopSpinnerTimer(): void {
  const timer = state.spinnerTimer;

  if (timer === undefined) {
    return;
  }

  clearInterval(timer);
  state.spinnerTimer = undefined;
}

function shouldStopSpinner(): boolean {
  return (
    state.isClosed ||
    state.isSuspended ||
    !hasRunningSnapshotWork(state.snapshot)
  );
}

function advanceSpinner(): void {
  state.spinnerFrameIndex =
    (state.spinnerFrameIndex + 1) % SPINNER_FRAMES.length;
  render();
}

function syncSpinnerTimer(): void {
  if (shouldStopSpinner()) {
    stopSpinnerTimer();
    return;
  }

  if (state.spinnerTimer !== undefined) {
    return;
  }

  state.spinnerTimer = setInterval(advanceSpinner, SPINNER_INTERVAL_MS);
}

function getOutputStream(
  streamName: 'stderr' | 'stdout' | undefined,
): NodeJS.WriteStream {
  return streamName === 'stderr' ? process.stderr : process.stdout;
}

function writeOutput(message: RendererMessageFor<'output'>): void {
  clearRenderedFrame();
  writeTracked(message.output.text, getOutputStream(message.output.stream));
  terminalFrame.reset();
  if (!state.isSuspended) render();
}

function requireMessage<Type extends RendererMessageType>(
  message: FlowRendererProcessMessage,
  type: Type,
): RendererMessageFor<Type> {
  if (message.type !== type) {
    throw new Error(`Unexpected renderer message: ${message.type}.`);
  }

  return message as RendererMessageFor<Type>;
}

function handleSnapshot(rawMessage: FlowRendererProcessMessage): void {
  const message = requireMessage(rawMessage, 'snapshot');
  state.snapshot = message.snapshot;
  syncSpinnerTimer();
  render();
}

function handleResume(rawMessage: FlowRendererProcessMessage): void {
  const message = requireMessage(rawMessage, 'resume');
  state.snapshot = message.snapshot;
  state.isSuspended = false;
  syncSpinnerTimer();
  render();
}

function handleSuspend(rawMessage: FlowRendererProcessMessage): void {
  requireMessage(rawMessage, 'suspend');
  stopSpinnerTimer();
  clearRenderedFrame();
  state.isSuspended = true;
  send({ type: 'suspended' });
}

function handleOutput(rawMessage: FlowRendererProcessMessage): void {
  writeOutput(requireMessage(rawMessage, 'output'));
}

function disconnectRenderer(exitCode: number): void {
  process.exitCode = exitCode;

  if (process.connected) {
    process.disconnect();
  }
}

function exitRenderer(): void {
  disconnectRenderer(0);
}

function handleClose(rawMessage: FlowRendererProcessMessage): void {
  const message = requireMessage(rawMessage, 'close');
  state.isClosed = true;
  state.isSuspended = false;
  state.snapshot = message.snapshot;
  stopSpinnerTimer();
  render();
  send({ type: 'closed' });
  setImmediate(exitRenderer);
}

const messageHandlers: Readonly<
  Record<RendererMessageType, RendererMessageHandler>
> = {
  close: handleClose,
  output: handleOutput,
  resume: handleResume,
  snapshot: handleSnapshot,
  suspend: handleSuspend,
};

function shouldCrash(message: FlowRendererProcessMessage): boolean {
  return (
    process.env.LIMINA_FLOW_RENDERER_TEST_CRASH === '1' &&
    message.type === 'snapshot'
  );
}

function handleRendererMessage(message: FlowRendererProcessMessage): void {
  if (shouldCrash(message)) {
    disconnectRenderer(1);
    return;
  }

  messageHandlers[message.type](message);
}

function formatRendererError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function handleProcessMessage(message: FlowRendererProcessMessage): void {
  try {
    handleRendererMessage(message);
  } catch (error) {
    send({
      message: formatRendererError(error),
      type: 'failed',
    });
  }
}

process.on('message', handleProcessMessage);

send({ type: 'ready' });
