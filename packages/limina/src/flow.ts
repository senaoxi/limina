import * as prompts from '@clack/prompts';
import { formatErrorMessage } from 'logaria/helper';

type FlowStatus = 'fail' | 'info' | 'pass' | 'skip' | 'start' | 'warn';

interface ClackLogAdapter {
  error: (message: string) => void;
  info: (message: string) => void;
  step: (message: string) => void;
  success: (message: string) => void;
  warn: (message: string) => void;
}

interface ClackAdapter {
  intro: (message: string) => void;
  log: ClackLogAdapter;
  outro: (message: string) => void;
}

interface FlowOutput {
  write: (message: string) => void;
}

interface FlowWriteStream {
  columns?: number;
  isTTY?: boolean;
  write?: unknown;
}

export interface LiminaFlowReporterOptions {
  clack?: ClackAdapter;
  env?: NodeJS.ProcessEnv;
  forceTty?: boolean;
  output?: FlowOutput;
  stderr?: FlowWriteStream;
  stdout?: FlowWriteStream;
}

export interface LiminaFlowMessageOptions {
  collapseOnSuccess?: boolean;
  depth?: number;
  elapsedTimeMs?: number;
}

export interface LiminaFlowFailureOptions extends LiminaFlowMessageOptions {
  error?: unknown;
}

export interface LiminaFlowTask {
  fail: (message?: string, options?: LiminaFlowFailureOptions) => void;
  info: (message: string, options?: LiminaFlowMessageOptions) => void;
  pass: (message?: string, options?: LiminaFlowMessageOptions) => void;
  skip: (message?: string, options?: LiminaFlowMessageOptions) => void;
  warn: (message: string, options?: LiminaFlowMessageOptions) => void;
}

export interface LiminaFlowOutputOptions {
  stream?: 'stderr' | 'stdout';
}

const DEFAULT_CI_ENV_VALUES = ['1', 'true'];
const DEFAULT_TERMINAL_COLUMNS = 80;
const ANSI_PATTERN = /\u001B\[[0-?]*[ -/]*[@-~]/gu;
const ANSI_RESET = '\u001B[0m';
const ANSI_GREEN = '\u001B[32m';
const ANSI_RED = '\u001B[31m';
const ANSI_YELLOW = '\u001B[33m';

const FLOW_SYMBOL_BY_STATUS: Record<FlowStatus, string> = {
  fail: '■',
  info: '│',
  pass: '◆',
  skip: '◇',
  start: '◇',
  warn: '▲',
};

function isCiEnvironment(env: NodeJS.ProcessEnv): boolean {
  return DEFAULT_CI_ENV_VALUES.includes(String(env.CI).toLowerCase());
}

function formatElapsedTime(milliseconds: number): string {
  if (milliseconds < 1000) {
    return `${Math.round(milliseconds)}ms`;
  }

  return `${(milliseconds / 1000).toFixed(2)}s`;
}

function formatMessageWithElapsed(
  message: string,
  elapsedTimeMs: number | undefined,
): string {
  return typeof elapsedTimeMs === 'number'
    ? `${message} (${formatElapsedTime(elapsedTimeMs)})`
    : message;
}

function formatFailureMessage(message: string, error: unknown): string {
  if (error === undefined) {
    return message;
  }

  const detail = formatErrorMessage(error).replace(/\s+/gu, ' ').trim();

  return detail ? `${message}: ${detail}` : message;
}

function indentMessage(message: string, depth: number): string {
  if (depth <= 0) {
    return message;
  }

  return `${'  '.repeat(depth)}${message}`;
}

function writeLine(output: FlowOutput, message: string): void {
  output.write(`${message}\n`);
}

function toWritableText(chunk: unknown): string {
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk).toString();
  }

  return String(chunk);
}

function stripControlSequences(text: string): string {
  return text.replace(ANSI_PATTERN, '').replaceAll('\r', '');
}

function colorInteractiveSymbol(status: FlowStatus, symbol: string): string {
  if (status === 'pass') {
    return `${ANSI_GREEN}${symbol}${ANSI_RESET}`;
  }

  if (status === 'fail') {
    return `${ANSI_RED}${symbol}${ANSI_RESET}`;
  }

  if (status === 'warn') {
    return `${ANSI_YELLOW}${symbol}${ANSI_RESET}`;
  }

  return symbol;
}

export class LiminaFlowReporter {
  readonly #clack: ClackAdapter;
  readonly #interactive: boolean;
  readonly #output: FlowOutput;
  readonly #stderr: FlowWriteStream | undefined;
  readonly #stdout: FlowWriteStream | undefined;
  readonly #tracksProcessWrites: boolean;
  readonly #interactiveHistory: string[] = [];
  #restoreWriteStreams: (() => void) | undefined;
  #trackedTaskCount = 0;
  #terminalColumn = 0;
  #terminalLineCount = 0;

  constructor(options: LiminaFlowReporterOptions = {}) {
    const env = options.env ?? process.env;
    const stdout = options.stdout ?? process.stdout;

    this.#interactive =
      options.forceTty ?? Boolean(stdout.isTTY && !isCiEnvironment(env));
    this.#clack = options.clack ?? prompts;
    this.#output =
      options.output ??
      ({
        write: (message: string) => {
          if (typeof stdout.write === 'function') {
            (stdout.write as (message: string) => boolean)(message);
            return;
          }

          process.stdout.write(message);
        },
      } satisfies FlowOutput);
    this.#stdout = stdout;
    this.#stderr = options.stderr ?? process.stderr;
    this.#tracksProcessWrites =
      this.#interactive && options.output === undefined;
  }

  get interactive(): boolean {
    return this.#interactive;
  }

  intro(message: string): void {
    if (this.#interactive) {
      this.#clack.intro(message);
      this.#interactiveHistory.push(`┌  ${message}`);
      return;
    }

    writeLine(this.#output, `[start] ${message}`);
  }

  outro(message: string): void {
    if (this.#interactive) {
      this.#clack.outro(message);
      return;
    }

    writeLine(this.#output, `[done] ${message}`);
  }

  start(
    message: string,
    options: LiminaFlowMessageOptions = {},
  ): LiminaFlowTask {
    const depth = options.depth ?? 0;
    const collapseOnSuccess = options.collapseOnSuccess ?? true;
    const shouldTrackTask = this.#interactive && collapseOnSuccess;
    const persistStart = !shouldTrackTask && this.#trackedTaskCount === 0;
    const startLine = this.#terminalLineCount;
    const startTime = performance.now();
    let completed = false;

    if (shouldTrackTask) {
      this.#beginTerminalTracking();
    }

    const persistedStartIndex = this.#emit('start', message, options, {
      persistInteractive: persistStart,
    });

    const finishTrackedTask = () => {
      if (!shouldTrackTask || completed) {
        return;
      }

      completed = true;
      this.#endTerminalTracking();
    };

    return {
      fail: (nextMessage, nextOptions) => {
        this.#emit(
          'fail',
          formatFailureMessage(nextMessage ?? message, nextOptions?.error),
          {
            ...nextOptions,
            depth,
            elapsedTimeMs:
              nextOptions?.elapsedTimeMs ?? performance.now() - startTime,
          },
          {
            persistInteractive: true,
          },
        );
        if (!this.#interactive) {
          return;
        }

        finishTrackedTask();
      },
      info: (nextMessage, nextOptions) => {
        this.info(nextMessage, {
          ...nextOptions,
          depth: nextOptions?.depth ?? depth + 1,
        });
      },
      pass: (nextMessage, nextOptions) => {
        const passOptions = {
          ...nextOptions,
          depth,
          elapsedTimeMs:
            nextOptions?.elapsedTimeMs ?? performance.now() - startTime,
        };
        const persistInteractive = shouldTrackTask
          ? this.#trackedTaskCount <= 1
          : this.#trackedTaskCount === 0;

        if (shouldTrackTask) {
          this.#clearInteractiveTaskBlock(startLine, {
            redrawHistory: persistInteractive && depth === 0,
          });
        }

        if (
          !shouldTrackTask &&
          this.#interactive &&
          persistedStartIndex !== undefined
        ) {
          this.#replaceInteractiveHistoryLine(
            persistedStartIndex,
            'pass',
            nextMessage ?? message,
            passOptions,
          );
          this.#redrawInteractiveHistory();
          finishTrackedTask();
          return;
        }

        this.#emit('pass', nextMessage ?? message, passOptions, {
          persistInteractive,
        });
        finishTrackedTask();
      },
      skip: (nextMessage, nextOptions) => {
        const skipOptions = {
          ...nextOptions,
          depth,
          elapsedTimeMs:
            nextOptions?.elapsedTimeMs ?? performance.now() - startTime,
        };

        if (
          !shouldTrackTask &&
          this.#interactive &&
          persistedStartIndex !== undefined
        ) {
          this.#replaceInteractiveHistoryLine(
            persistedStartIndex,
            'skip',
            nextMessage ?? message,
            skipOptions,
          );
          this.#redrawInteractiveHistory();
          finishTrackedTask();
          return;
        }

        this.#emit('skip', nextMessage ?? message, skipOptions, {
          persistInteractive: this.#trackedTaskCount === 0,
        });
        finishTrackedTask();
      },
      warn: (nextMessage, nextOptions) => {
        this.warn(nextMessage, {
          ...nextOptions,
          depth: nextOptions?.depth ?? depth + 1,
        });
      },
    };
  }

  fail(message: string, options: LiminaFlowFailureOptions = {}): void {
    this.#emit('fail', formatFailureMessage(message, options.error), options, {
      persistInteractive: true,
    });
  }

  info(message: string, options: LiminaFlowMessageOptions = {}): void {
    this.#emit('info', message, options);
  }

  pass(message: string, options: LiminaFlowMessageOptions = {}): void {
    this.#emit('pass', message, options, {
      persistInteractive: true,
    });
  }

  skip(message: string, options: LiminaFlowMessageOptions = {}): void {
    this.#emit('skip', message, options, {
      persistInteractive: true,
    });
  }

  warn(message: string, options: LiminaFlowMessageOptions = {}): void {
    this.#emit('warn', message, options);
  }

  writeOutput(
    message: string | Uint8Array,
    options: LiminaFlowOutputOptions = {},
  ): void {
    const stream = options.stream === 'stderr' ? this.#stderr : this.#stdout;

    if (
      this.#interactive &&
      this.#tracksProcessWrites &&
      typeof stream?.write === 'function'
    ) {
      (stream.write as (message: string | Uint8Array) => boolean)(message);
      return;
    }

    this.#writeTracked(toWritableText(message));
  }

  #emit(
    status: FlowStatus,
    rawMessage: string,
    options: LiminaFlowMessageOptions,
    meta: { persistInteractive?: boolean } = {},
  ): number | undefined {
    const message = formatMessageWithElapsed(rawMessage, options.elapsedTimeMs);
    const depth = options.depth ?? 0;

    if (this.#interactive) {
      const renderedLine = this.#formatInteractiveLine(status, message, depth);
      let historyIndex: number | undefined;

      if (meta.persistInteractive) {
        historyIndex = this.#interactiveHistory.length;
        this.#interactiveHistory.push(renderedLine);
      }

      writeLine(
        {
          write: (nextMessage) => {
            this.#writeTracked(nextMessage);
          },
        },
        renderedLine,
      );
      return historyIndex;
    }

    writeLine(this.#output, `${'  '.repeat(depth)}[${status}] ${message}`);
    return undefined;
  }

  #beginTerminalTracking(): void {
    this.#trackedTaskCount += 1;

    if (this.#trackedTaskCount > 1 || !this.#tracksProcessWrites) {
      return;
    }

    const restoreStdout = this.#patchWriteStream(this.#stdout);
    const restoreStderr = this.#patchWriteStream(this.#stderr);

    this.#restoreWriteStreams = () => {
      restoreStdout?.();
      restoreStderr?.();
      this.#restoreWriteStreams = undefined;
    };
  }

  #clearInteractiveTaskBlock(
    startLine: number,
    options: { redrawHistory?: boolean } = {},
  ): void {
    const linesToClear = this.#terminalLineCount - startLine;

    if (linesToClear <= 0) {
      return;
    }

    if (options.redrawHistory) {
      this.#redrawInteractiveHistory();
      return;
    }

    this.#writeControl(`\r\u001B[${linesToClear}A\u001B[J`);
    this.#terminalLineCount = startLine;
    this.#terminalColumn = 0;
  }

  #endTerminalTracking(): void {
    this.#trackedTaskCount = Math.max(0, this.#trackedTaskCount - 1);

    if (this.#trackedTaskCount === 0) {
      this.#restoreWriteStreams?.();
    }
  }

  #patchWriteStream(
    stream: FlowWriteStream | undefined,
  ): (() => void) | undefined {
    if (typeof stream?.write !== 'function') {
      return undefined;
    }

    const originalWrite = stream.write as (...args: unknown[]) => boolean;

    (stream as { write: (...args: unknown[]) => boolean }).write = (
      ...args: unknown[]
    ) => {
      this.#recordTerminalWrite(args[0]);

      return Reflect.apply(originalWrite, stream, args) as boolean;
    };

    return () => {
      stream.write = originalWrite;
    };
  }

  #recordTerminalWrite(chunk: unknown): void {
    const text = stripControlSequences(toWritableText(chunk));
    const columns = Math.max(
      1,
      this.#stdout?.columns ?? DEFAULT_TERMINAL_COLUMNS,
    );

    for (const char of text) {
      if (char === '\n') {
        this.#terminalLineCount += 1;
        this.#terminalColumn = 0;
        continue;
      }

      this.#terminalColumn += 1;

      if (this.#terminalColumn >= columns) {
        this.#terminalLineCount += 1;
        this.#terminalColumn = 0;
      }
    }
  }

  #redrawInteractiveHistory(): void {
    this.#writeControl('\r\u001B[H\u001B[2J\u001B[3J');
    this.#terminalLineCount = 0;
    this.#terminalColumn = 0;

    for (const line of this.#interactiveHistory) {
      writeLine(
        {
          write: (message) => {
            this.#writeTracked(message);
          },
        },
        line,
      );
    }
  }

  #formatInteractiveLine(
    status: FlowStatus,
    message: string,
    depth: number,
  ): string {
    const renderedMessage = indentMessage(message, depth);

    return `${colorInteractiveSymbol(
      status,
      FLOW_SYMBOL_BY_STATUS[status],
    )}    ${renderedMessage}`;
  }

  #replaceInteractiveHistoryLine(
    index: number,
    status: FlowStatus,
    rawMessage: string,
    options: LiminaFlowMessageOptions,
  ): void {
    this.#interactiveHistory[index] = this.#formatInteractiveLine(
      status,
      formatMessageWithElapsed(rawMessage, options.elapsedTimeMs),
      options.depth ?? 0,
    );
  }

  #writeControl(message: string): void {
    this.#output.write(message);
  }

  #writeTracked(message: string): void {
    if (!this.#tracksProcessWrites) {
      this.#recordTerminalWrite(message);
    }

    this.#output.write(message);
  }
}

export function createLiminaFlowReporter(
  options: LiminaFlowReporterOptions = {},
): LiminaFlowReporter {
  return new LiminaFlowReporter(options);
}
