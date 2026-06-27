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

let snapshot: FlowRenderSnapshot = {
  entries: [],
  treeRoots: [],
};
const terminalFrame = new TerminalFrameTracker(getTerminalColumns);
let spinnerFrameIndex = 0;
let spinnerTimer: NodeJS.Timeout | undefined;
let closed = false;

function send(message: FlowRendererParentMessage): void {
  if (typeof process.send === 'function') {
    process.send(message);
  }
}

function readPositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function getTerminalColumns(): number {
  return Math.max(1, process.stdout.columns ?? DEFAULT_TERMINAL_COLUMNS);
}

function getTerminalRows(): number | undefined {
  return (
    readPositiveInteger(process.env.LIMINA_FLOW_RENDERER_TEST_ROWS) ??
    process.stdout.rows
  );
}

function writeTracked(message: string, stream: NodeJS.WriteStream): void {
  terminalFrame.record(message);
  stream.write(message);
}

function clearRenderedFrame(): void {
  if (terminalFrame.lineCount <= 0) {
    return;
  }

  process.stdout.write(`\r\u001B[${terminalFrame.lineCount}A\u001B[J`);
  terminalFrame.reset();
}

function render(): void {
  clearRenderedFrame();

  const dimensions = {
    columns: snapshot.terminalDimensions?.columns ?? getTerminalColumns(),
    rows: snapshot.terminalDimensions?.rows ?? getTerminalRows(),
  };
  const renderedLines = renderSnapshotLinesForTerminal(
    snapshot,
    spinnerFrameIndex,
    dimensions,
  );

  for (const line of renderedLines) {
    writeTracked(`${line}\n`, process.stdout);
  }
}

function syncSpinnerTimer(): void {
  if (closed || !hasRunningSnapshotWork(snapshot)) {
    if (spinnerTimer) {
      clearInterval(spinnerTimer);
      spinnerTimer = undefined;
    }
    return;
  }

  if (spinnerTimer) {
    return;
  }

  spinnerTimer = setInterval(() => {
    spinnerFrameIndex = (spinnerFrameIndex + 1) % SPINNER_FRAMES.length;
    render();
  }, SPINNER_INTERVAL_MS);
}

function writeOutput(message: FlowRendererProcessMessage & { type: 'output' }) {
  clearRenderedFrame();
  writeTracked(
    message.output.text,
    message.output.stream === 'stderr' ? process.stderr : process.stdout,
  );
  terminalFrame.reset();
  render();
}

process.on('message', (rawMessage: FlowRendererProcessMessage) => {
  try {
    if (
      process.env.LIMINA_FLOW_RENDERER_TEST_CRASH === '1' &&
      rawMessage.type === 'snapshot'
    ) {
      process.exit(1);
    }

    switch (rawMessage.type) {
      case 'snapshot': {
        snapshot = rawMessage.snapshot;
        syncSpinnerTimer();
        render();
        break;
      }
      case 'output': {
        writeOutput(rawMessage);
        break;
      }
      case 'close': {
        closed = true;
        snapshot = rawMessage.snapshot;
        if (spinnerTimer) {
          clearInterval(spinnerTimer);
          spinnerTimer = undefined;
        }
        render();
        send({ type: 'closed' });
        setImmediate(() => {
          process.exit(0);
        });
        break;
      }
    }
  } catch (error) {
    send({
      message: error instanceof Error ? error.message : String(error),
      type: 'failed',
    });
  }
});

send({ type: 'ready' });
