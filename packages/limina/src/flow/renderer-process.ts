import {
  type FlowRendererParentMessage,
  type FlowRendererProcessMessage,
  type FlowRenderSnapshot,
  hasRunningSnapshotWork,
  renderSnapshotLines,
  SPINNER_FRAMES,
  SPINNER_INTERVAL_MS,
  toWritableText,
} from './render-model';

const DEFAULT_TERMINAL_COLUMNS = 80;
const ANSI_ESCAPE = String.fromCodePoint(0x1b);
const ANSI_PATTERN = new RegExp(
  String.raw`${ANSI_ESCAPE}\[[\d:;<=>?]*[\u0020-\u002F]*[\u0040-\u007E]`,
  'gu',
);

let snapshot: FlowRenderSnapshot = {
  entries: [],
  treeRoots: [],
};
let terminalColumn = 0;
let terminalLineCount = 0;
let spinnerFrameIndex = 0;
let spinnerTimer: NodeJS.Timeout | undefined;
let closed = false;

function send(message: FlowRendererParentMessage): void {
  if (typeof process.send === 'function') {
    process.send(message);
  }
}

function stripControlSequences(text: string): string {
  return text.replaceAll(ANSI_PATTERN, '').replaceAll('\r', '');
}

function recordTerminalWrite(chunk: unknown): void {
  const text = stripControlSequences(toWritableText(chunk));
  const columns = Math.max(
    1,
    process.stdout.columns ?? DEFAULT_TERMINAL_COLUMNS,
  );

  for (const char of text) {
    if (char === '\n') {
      terminalLineCount += 1;
      terminalColumn = 0;
      continue;
    }

    terminalColumn += 1;

    if (terminalColumn >= columns) {
      terminalLineCount += 1;
      terminalColumn = 0;
    }
  }
}

function writeTracked(message: string, stream: NodeJS.WriteStream): void {
  recordTerminalWrite(message);
  stream.write(message);
}

function clearRenderedFrame(): void {
  if (terminalLineCount <= 0) {
    return;
  }

  process.stdout.write(`\r\u001B[${terminalLineCount}A\u001B[J`);
  terminalLineCount = 0;
  terminalColumn = 0;
}

function render(): void {
  clearRenderedFrame();

  for (const line of renderSnapshotLines(snapshot, spinnerFrameIndex)) {
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
  terminalLineCount = 0;
  terminalColumn = 0;
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
