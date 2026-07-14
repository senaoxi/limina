import * as prompts from '@clack/prompts';
import { formatErrorMessage } from 'logaria/helper';
import { FlowProcessRenderer } from './flow/process-renderer';
import {
  type FlowRenderSnapshot,
  type FlowStatus,
  type FlowTerminalDimensions,
  type FlowTreeNodeStatus,
  type FlowWritableChunk,
  formatMessageWithElapsed,
  formatInteractiveLine as formatRenderedInteractiveLine,
  hasRunningSnapshotWork,
  type FlowRenderHistoryEntry as InteractiveHistoryEntry,
  type FlowRenderFlowLine as InteractiveHistoryFlowLine,
  renderSnapshotLinesForTerminal,
  SPINNER_FRAMES,
  SPINNER_INTERVAL_MS,
  toTreeFlowStatus,
  toWritableText,
} from './flow/render-model';
import {
  DEFAULT_TERMINAL_COLUMNS,
  type FlowWriteStream,
  patchWriteStream,
  TerminalFrameTracker,
} from './flow/terminal-frame';
import {
  appendFlowTreeChild,
  cloneFlowTreeNode,
  createFlowTreeNode,
  type FlowTreeNodeInternal,
  skipPlannedTreeDescendants,
} from './flow/tree-state';

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

export interface LiminaFlowReporterOptions {
  clack?: ClackAdapter;
  env?: NodeJS.ProcessEnv;
  forceTty?: boolean;
  output?: FlowOutput;
  renderer?: 'auto' | 'inline' | 'process';
  stderr?: FlowWriteStream;
  stdout?: FlowWriteStream;
}

export interface LiminaFlowMessageOptions {
  collapseOnSuccess?: boolean;
  depth?: number;
  elapsedTimeMs?: number;
  persistInteractive?: boolean;
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

export interface LiminaFlowTreeNode {
  block: (message?: string, options?: LiminaFlowMessageOptions) => void;
  child: (
    message: string,
    options?: LiminaFlowMessageOptions,
  ) => LiminaFlowTreeNode;
  children: (
    messages: readonly string[],
    options?: LiminaFlowMessageOptions,
  ) => LiminaFlowTreeNode[];
  fail: (message?: string, options?: LiminaFlowFailureOptions) => void;
  pass: (message?: string, options?: LiminaFlowMessageOptions) => void;
  skip: (message?: string, options?: LiminaFlowMessageOptions) => void;
  start: (message?: string, options?: LiminaFlowMessageOptions) => void;
}

export interface LiminaFlowOutputOptions {
  stream?: 'stderr' | 'stdout';
}

const CHECK_FLOW_STATUS_ONLY_OPTION = Symbol('limina.checkFlowStatusOnly');
const DEFAULT_CI_ENV_VALUES = new Set(['1', 'true']);
const FLOW_RENDERER_TEST_ROWS_ENV = 'LIMINA_FLOW_RENDERER_TEST_ROWS';

type InteractiveEntryReference =
  | {
      collection: 'history';
      index: number;
    }
  | {
      collection: 'transient';
      id: number;
    };

interface ProcessTransientHistoryEntry {
  entry: InteractiveHistoryEntry;
  id: number;
  taskId?: number;
}

function isCiEnvironment(env: NodeJS.ProcessEnv): boolean {
  return (
    DEFAULT_CI_ENV_VALUES.has(String(env.CI).toLowerCase()) ||
    DEFAULT_CI_ENV_VALUES.has(String(env.CODEX_CI).toLowerCase())
  );
}

function supportsInteractiveTerminal(
  env: NodeJS.ProcessEnv,
  stdout: FlowWriteStream,
): boolean {
  if (!stdout.isTTY || isCiEnvironment(env)) {
    return false;
  }

  return String(env.TERM).toLowerCase() !== 'dumb';
}

function formatFailureMessage(message: string, error: unknown): string {
  if (error === undefined) {
    return message;
  }

  const detail = formatErrorMessage(error).replaceAll(/\s+/gu, ' ').trim();

  return detail ? `${message}: ${detail}` : message;
}

function writeLine(output: FlowOutput, message: string): void {
  output.write(`${message}\n`);
}

function createTaskFinishOptions<T extends LiminaFlowMessageOptions>(
  options: T | undefined,
  depth: number,
  startTime: number,
): T & Required<Pick<LiminaFlowMessageOptions, 'depth' | 'elapsedTimeMs'>> {
  return {
    ...options,
    depth,
    elapsedTimeMs: options?.elapsedTimeMs ?? performance.now() - startTime,
  } as T & Required<Pick<LiminaFlowMessageOptions, 'depth' | 'elapsedTimeMs'>>;
}

function readPositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export class LiminaFlowReporter {
  readonly #clack: ClackAdapter;
  readonly #env: NodeJS.ProcessEnv;
  readonly #interactive: boolean;
  readonly #output: FlowOutput;
  readonly #statusOnly: boolean;
  readonly #stderr: FlowWriteStream | undefined;
  readonly #stdout: FlowWriteStream | undefined;
  readonly #terminalFrame: TerminalFrameTracker;
  readonly #tracksProcessWrites: boolean;
  readonly #interactiveHistory: InteractiveHistoryEntry[] = [];
  readonly #treeRoots: FlowTreeNodeInternal[] = [];
  #hasInteractiveTree = false;
  #outroMessage: string | undefined;
  #processRenderer: FlowProcessRenderer | undefined;
  #processTransientHistory: ProcessTransientHistoryEntry[] = [];
  #nextProcessTransientEntryId = 0;
  #nextProcessTransientTaskId = 0;
  #restoreWriteStreams: (() => void) | undefined;
  #spinnerFrameIndex = 0;
  #spinnerTimer: NodeJS.Timeout | undefined;
  #trackedTaskCount = 0;

  constructor(options: LiminaFlowReporterOptions = {}) {
    const env = options.env ?? process.env;
    const stdout = options.stdout ?? process.stdout;
    const internalOptions = options as LiminaFlowReporterOptions & {
      [CHECK_FLOW_STATUS_ONLY_OPTION]?: boolean;
    };

    this.#statusOnly = internalOptions[CHECK_FLOW_STATUS_ONLY_OPTION] === true;
    this.#env = env;
    this.#interactive =
      options.forceTty ?? supportsInteractiveTerminal(env, stdout);
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
    this.#terminalFrame = new TerminalFrameTracker(
      () => this.#stdout?.columns ?? DEFAULT_TERMINAL_COLUMNS,
    );
    this.#processRenderer = this.#createProcessRenderer(options);
    this.#tracksProcessWrites =
      this.#interactive &&
      !this.#statusOnly &&
      options.output === undefined &&
      !this.#processRenderer;
  }

  get interactive(): boolean {
    return this.#interactive;
  }

  get rendererBackend(): 'inline' | 'process' {
    return this.#processRenderer ? 'process' : 'inline';
  }

  waitForRendererReady(): Promise<boolean> {
    return this.#processRenderer?.ready ?? Promise.resolve(false);
  }

  #createProcessRenderer(
    options: LiminaFlowReporterOptions,
  ): FlowProcessRenderer | undefined {
    const rendererMode = options.renderer ?? 'auto';

    // The process renderer owns raw stdout/stderr while commands run. Keep it
    // for real CLI sessions, but avoid it when tests inject streams/adapters.
    if (
      !this.#interactive ||
      rendererMode === 'inline' ||
      options.output !== undefined ||
      options.stdout !== undefined ||
      options.stderr !== undefined ||
      options.clack !== undefined
    ) {
      return undefined;
    }

    return FlowProcessRenderer.start();
  }

  #createRenderSnapshot(): FlowRenderSnapshot {
    const terminalDimensions = this.#getTerminalDimensions();
    const hasTerminalDimensions =
      terminalDimensions.columns !== undefined ||
      terminalDimensions.rows !== undefined;

    return {
      // check-flow is status-only: details still exist in snapshots, but the
      // terminal frame should prefer the compact task-state view.
      ...(this.#statusOnly
        ? {
            compactMode: 'check-flow' as const,
          }
        : {}),
      entries: [
        ...this.#interactiveHistory,
        ...this.#processTransientHistory.map(({ entry }) => entry),
      ],
      ...(this.#outroMessage === undefined
        ? {}
        : { outroMessage: this.#outroMessage }),
      ...(hasTerminalDimensions ? { terminalDimensions } : {}),
      treeRoots: this.#treeRoots.map(cloneFlowTreeNode),
    };
  }

  #getTerminalDimensions(): FlowTerminalDimensions {
    return {
      columns: this.#stdout?.columns,
      rows:
        readPositiveInteger(this.#env[FLOW_RENDERER_TEST_ROWS_ENV]) ??
        this.#stdout?.rows,
    };
  }

  #sendProcessSnapshot(): void {
    if (!this.#processRenderer?.active) {
      return;
    }

    this.#processRenderer.sendSnapshot(this.#createRenderSnapshot());
  }

  #writeRenderSnapshotInline(snapshot: FlowRenderSnapshot): void {
    const lines = renderSnapshotLinesForTerminal(
      snapshot,
      this.#spinnerFrameIndex,
      this.#getTerminalDimensions(),
    );

    for (const line of lines) {
      writeLine(this.#output, line);
    }
  }

  intro(message: string): void {
    if (this.#interactive) {
      if (this.#processRenderer?.active) {
        this.#interactiveHistory.push({
          kind: 'line',
          line: `┌  ${message}`,
        });
        this.#sendProcessSnapshot();
        return;
      }

      this.#clack.intro(message);
      this.#interactiveHistory.push({
        kind: 'line',
        line: `┌  ${message}`,
      });
      this.#terminalFrame.record(`${message}\n`);
      return;
    }

    writeLine(this.#output, `[start] ${message}`);
  }

  outro(message: string): void {
    if (this.#interactive) {
      if (this.#processRenderer?.active) {
        this.#outroMessage = message;
        this.#sendProcessSnapshot();
        return;
      }

      if (this.#statusOnly) {
        this.#outroMessage = message;
        this.#redrawInteractiveHistory();
        return;
      }

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
    const collapseOnSuccess = this.#statusOnly
      ? false
      : (options.collapseOnSuccess ?? true);
    const shouldTrackTask = this.#interactive && collapseOnSuccess;
    const persistStart = !shouldTrackTask && this.#trackedTaskCount === 0;
    const startLine = this.#terminalFrame.lineCount;
    const startTime = performance.now();
    const processTransientTaskId =
      shouldTrackTask && this.#processRenderer
        ? this.#nextProcessTransientTaskId++
        : undefined;
    let completed = false;

    if (shouldTrackTask) {
      this.#beginTerminalTracking();
    }

    const persistedStartIndex = this.#emit('start', message, options, {
      persistInteractive: persistStart,
      transientTaskId: processTransientTaskId,
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
        const failOptions = createTaskFinishOptions(
          nextOptions,
          depth,
          startTime,
        );
        const failMessage = this.#statusOnly
          ? message
          : (nextMessage ?? message);

        if (
          !shouldTrackTask &&
          this.#interactive &&
          persistedStartIndex !== undefined
        ) {
          this.#replaceInteractiveHistoryLine(
            persistedStartIndex,
            'fail',
            this.#formatFailureMessage(failMessage, nextOptions),
            failOptions,
          );
          this.#redrawInteractiveHistory();
          finishTrackedTask();
          return;
        }

        this.#emit(
          'fail',
          this.#formatFailureMessage(failMessage, nextOptions),
          failOptions,
          {
            persistInteractive: true,
          },
        );
        finishTrackedTask();
      },
      info: (nextMessage, nextOptions) => {
        this.info(nextMessage, {
          ...nextOptions,
          depth: nextOptions?.depth ?? depth + 1,
        });
      },
      pass: (nextMessage, nextOptions) => {
        const passOptions = createTaskFinishOptions(
          nextOptions,
          depth,
          startTime,
        );
        const persistInteractive = shouldTrackTask
          ? this.#trackedTaskCount <= 1
          : this.#trackedTaskCount === 0;

        if (shouldTrackTask) {
          if (this.#processRenderer?.active) {
            this.#processTransientHistory =
              this.#processTransientHistory.filter(
                (entry) => entry.taskId !== processTransientTaskId,
              );
            this.#sendProcessSnapshot();
          } else {
            this.#clearInteractiveTaskBlock(startLine, {
              redrawHistory: persistInteractive && depth === 0,
            });
          }
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
        const skipOptions = createTaskFinishOptions(
          nextOptions,
          depth,
          startTime,
        );

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

  tree(
    message: string,
    options: LiminaFlowMessageOptions = {},
  ): LiminaFlowTreeNode {
    const node = createFlowTreeNode(message, options.depth ?? 0);

    this.#treeRoots.push(node);
    this.#ensureInteractiveTree();
    this.#renderTreeChange();

    return this.#createTreeNodeHandle(node);
  }

  fail(message: string, options: LiminaFlowFailureOptions = {}): void {
    this.#emit('fail', this.#formatFailureMessage(message, options), options, {
      persistInteractive: true,
    });
  }

  info(message: string, options: LiminaFlowMessageOptions = {}): void {
    // check-flow is the terse status surface used by `limina check`; detailed
    // diagnostics are emitted by the summary/issue reports after the flow.
    if (this.#statusOnly) {
      return;
    }

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
    // Warnings are intentionally hidden from check-flow for the same reason as
    // info lines: the flow should stay a compact status list.
    if (this.#statusOnly) {
      return;
    }

    this.#emit('warn', message, options, {
      persistInteractive: options.persistInteractive,
    });
  }

  writeOutput(
    message: FlowWritableChunk,
    options: LiminaFlowOutputOptions = {},
  ): void {
    if (this.#statusOnly) {
      return;
    }

    if (this.#processRenderer?.active) {
      this.#processRenderer.writeOutput({
        stream: options.stream,
        text: toWritableText(message),
      });
      return;
    }

    const stream = options.stream === 'stderr' ? this.#stderr : this.#stdout;

    if (
      this.#interactive &&
      this.#tracksProcessWrites &&
      typeof stream?.write === 'function'
    ) {
      if (this.#restoreWriteStreams === undefined) {
        this.#terminalFrame.record(message);
      }
      stream.write(message);
      return;
    }

    this.#writeTracked(toWritableText(message));
  }

  async close(): Promise<void> {
    if (this.#processRenderer) {
      const snapshot = this.#createRenderSnapshot();
      const completed = await this.#processRenderer.close(snapshot);

      this.#processRenderer = undefined;
      if (!completed) {
        this.#writeRenderSnapshotInline(snapshot);
      }
      return;
    }

    if (this.#spinnerTimer) {
      clearInterval(this.#spinnerTimer);
      this.#spinnerTimer = undefined;
    }
  }

  #emit(
    status: FlowStatus,
    rawMessage: string,
    options: LiminaFlowMessageOptions,
    meta: { persistInteractive?: boolean; transientTaskId?: number } = {},
  ): InteractiveEntryReference | undefined {
    if (this.#statusOnly && (status === 'info' || status === 'warn')) {
      return undefined;
    }

    const message = formatMessageWithElapsed(rawMessage, options.elapsedTimeMs);
    const depth = options.depth ?? 0;

    if (this.#interactive) {
      const renderedLine = this.#formatInteractiveLine(status, message, depth);
      const entry: InteractiveHistoryFlowLine = {
        depth,
        elapsedTimeMs: options.elapsedTimeMs,
        kind: 'flow-line',
        message: rawMessage,
        status,
      };
      let historyReference: InteractiveEntryReference | undefined;

      if (meta.persistInteractive) {
        historyReference = {
          collection: 'history',
          index: this.#interactiveHistory.length,
        };
        this.#interactiveHistory.push(entry);
      }

      if (this.#processRenderer?.active) {
        if (!meta.persistInteractive) {
          const transientId = this.#nextProcessTransientEntryId++;

          historyReference = {
            collection: 'transient',
            id: transientId,
          };
          this.#processTransientHistory.push({
            entry,
            id: transientId,
            taskId: meta.transientTaskId,
          });
        }

        this.#sendProcessSnapshot();
        return historyReference;
      }

      writeLine(
        {
          write: (nextMessage) => {
            this.#writeTracked(nextMessage, {
              forceRecord: this.#restoreWriteStreams === undefined,
            });
          },
        },
        renderedLine,
      );
      this.#syncSpinnerTimer();
      return historyReference;
    }

    writeLine(this.#output, `${'  '.repeat(depth)}[${status}] ${message}`);
    return undefined;
  }

  #beginTerminalTracking(): void {
    this.#trackedTaskCount += 1;

    if (this.#trackedTaskCount > 1 || !this.#tracksProcessWrites) {
      return;
    }

    // Collapsed tasks may write command output directly to stdio. While the
    // task is running, patch writes so the cleanup cursor math still knows how
    // many terminal rows the task occupied.
    const restoreStdout = patchWriteStream(this.#stdout, (chunk) => {
      this.#terminalFrame.record(chunk);
    });
    const restoreStderr = patchWriteStream(this.#stderr, (chunk) => {
      this.#terminalFrame.record(chunk);
    });

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
    const linesToClear = this.#terminalFrame.lineCount - startLine;

    if (linesToClear <= 0) {
      return;
    }

    if (options.redrawHistory) {
      this.#redrawInteractiveHistory();
      return;
    }

    this.#writeControl(`\r\u001B[${linesToClear}A\u001B[J`);
    this.#terminalFrame.setLineCount(startLine);
  }

  #endTerminalTracking(): void {
    this.#trackedTaskCount = Math.max(0, this.#trackedTaskCount - 1);

    if (this.#trackedTaskCount === 0) {
      this.#restoreWriteStreams?.();
    }
  }

  #redrawInteractiveHistory(): void {
    if (this.#processRenderer?.active) {
      this.#sendProcessSnapshot();
      return;
    }

    if (this.#terminalFrame.lineCount > 0) {
      this.#writeControl(`\r\u001B[${this.#terminalFrame.lineCount}A\u001B[J`);
    }

    this.#terminalFrame.reset();

    const frameLines = renderSnapshotLinesForTerminal(
      this.#createRenderSnapshot(),
      this.#spinnerFrameIndex,
      this.#getTerminalDimensions(),
    );

    for (const line of frameLines) {
      writeLine(
        {
          write: (message) => {
            this.#writeTracked(message, {
              forceRecord: this.#restoreWriteStreams === undefined,
            });
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
    return formatRenderedInteractiveLine(
      status,
      message,
      depth,
      this.#spinnerFrameIndex,
    );
  }

  #replaceInteractiveHistoryLine(
    reference: InteractiveEntryReference,
    status: FlowStatus,
    rawMessage: string,
    options: LiminaFlowMessageOptions,
  ): void {
    const entry: InteractiveHistoryFlowLine = {
      depth: options.depth ?? 0,
      elapsedTimeMs: options.elapsedTimeMs,
      kind: 'flow-line',
      message: rawMessage,
      status,
    };

    if (reference.collection === 'history') {
      this.#interactiveHistory[reference.index] = entry;
    } else {
      const transientEntry = this.#processTransientHistory.find(
        (candidate) => candidate.id === reference.id,
      );

      if (transientEntry) {
        transientEntry.entry = entry;
      }
    }

    if (this.#processRenderer?.active) {
      this.#sendProcessSnapshot();
      return;
    }

    this.#syncSpinnerTimer();
  }

  #createTreeNodeHandle(node: FlowTreeNodeInternal): LiminaFlowTreeNode {
    return {
      block: (message, options) => {
        this.#finishTreeNode(node, 'blocked', message, options);
      },
      child: (message, options = {}) => {
        const childNode = appendFlowTreeChild(
          node,
          message,
          options.depth ?? node.depth + 1,
        );

        this.#renderTreeChange();

        return this.#createTreeNodeHandle(childNode);
      },
      children: (messages, options = {}) => {
        const childNodes = messages.map((message) =>
          appendFlowTreeChild(node, message, options.depth ?? node.depth + 1),
        );

        if (childNodes.length > 0) {
          this.#renderTreeChange();
        }

        return childNodes.map((childNode) =>
          this.#createTreeNodeHandle(childNode),
        );
      },
      fail: (message, options) => {
        this.#finishTreeNode(node, 'failed', message, options);
      },
      pass: (message, options) => {
        this.#finishTreeNode(node, 'passed', message, options);
      },
      skip: (message, options) => {
        this.#finishTreeNode(node, 'skipped', message, options);
      },
      start: (message, options) => {
        if (message) {
          node.message = message;
        }

        if (options?.depth !== undefined) {
          node.depth = options.depth;
        }

        node.status = 'running';
        node.startedAt = performance.now();
        node.elapsedTimeMs = undefined;

        if (!this.#interactive) {
          this.#emit('start', node.message, {
            ...options,
            depth: node.depth,
          });
          return;
        }

        this.#renderTreeChange();
      },
    };
  }

  #ensureInteractiveTree(): void {
    if (!this.#interactive || this.#hasInteractiveTree) {
      return;
    }

    this.#interactiveHistory.push({
      kind: 'tree',
    });
    this.#hasInteractiveTree = true;
  }

  #finishTreeNode(
    node: FlowTreeNodeInternal,
    status: Exclude<FlowTreeNodeStatus, 'planned' | 'running'>,
    message: string | undefined,
    options: LiminaFlowFailureOptions | LiminaFlowMessageOptions | undefined,
  ): void {
    skipPlannedTreeDescendants(node);

    if (message) {
      node.message =
        status === 'failed'
          ? this.#formatFailureMessage(
              message,
              options as LiminaFlowFailureOptions | undefined,
            )
          : message;
    } else if (status === 'failed') {
      node.message = this.#formatFailureMessage(
        node.message,
        options as LiminaFlowFailureOptions | undefined,
      );
    }

    if (options?.depth !== undefined) {
      node.depth = options.depth;
    }

    node.status = status;
    node.elapsedTimeMs =
      options?.elapsedTimeMs ??
      (node.startedAt === undefined
        ? undefined
        : performance.now() - node.startedAt);

    const flowStatus = toTreeFlowStatus(status);

    if (!this.#interactive) {
      this.#emit(flowStatus, node.message, {
        ...options,
        depth: node.depth,
        elapsedTimeMs: node.elapsedTimeMs,
      });
      return;
    }

    this.#renderTreeChange();
  }

  #renderTreeChange(): void {
    if (!this.#interactive) {
      return;
    }

    if (this.#processRenderer?.active) {
      this.#sendProcessSnapshot();
      return;
    }

    this.#syncSpinnerTimer();
    this.#redrawInteractiveHistory();
  }

  #hasRunningInteractiveWork(): boolean {
    return hasRunningSnapshotWork(this.#createRenderSnapshot());
  }

  #syncSpinnerTimer(): void {
    if (!this.#interactive || !this.#hasRunningInteractiveWork()) {
      if (this.#spinnerTimer) {
        clearInterval(this.#spinnerTimer);
        this.#spinnerTimer = undefined;
      }
      return;
    }

    if (this.#spinnerTimer) {
      return;
    }

    this.#spinnerTimer = setInterval(() => {
      this.#spinnerFrameIndex =
        (this.#spinnerFrameIndex + 1) % SPINNER_FRAMES.length;
      this.#redrawInteractiveHistory();
    }, SPINNER_INTERVAL_MS);
    this.#spinnerTimer.unref?.();
  }

  #formatFailureMessage(
    message: string,
    options: LiminaFlowFailureOptions | undefined,
  ): string {
    if (this.#statusOnly) {
      return message;
    }

    return formatFailureMessage(message, options?.error);
  }

  #writeControl(message: string): void {
    this.#output.write(message);
  }

  #writeTracked(
    message: string,
    options: { forceRecord?: boolean } = {},
  ): void {
    if (options.forceRecord || !this.#tracksProcessWrites) {
      this.#terminalFrame.record(message);
    }

    this.#output.write(message);
  }
}

export function createLiminaFlowReporter(
  options: LiminaFlowReporterOptions = {},
): LiminaFlowReporter {
  return new LiminaFlowReporter(options);
}

export function createLiminaCheckFlowReporter(
  options: LiminaFlowReporterOptions = {},
): LiminaFlowReporter {
  return new LiminaFlowReporter({
    ...options,
    [CHECK_FLOW_STATUS_ONLY_OPTION]: true,
  } as LiminaFlowReporterOptions);
}
