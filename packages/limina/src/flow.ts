import * as prompts from '@clack/prompts';
import { formatErrorMessage } from 'logaria/helper';
import { FlowProcessRenderer } from './flow/process-renderer';
import {
  type FlowRenderSnapshot,
  type FlowRenderTreeNode,
  type FlowStatus,
  type FlowTreeNodeStatus,
  formatMessageWithElapsed,
  formatInteractiveLine as formatRenderedInteractiveLine,
  hasRunningSnapshotWork,
  type FlowRenderHistoryEntry as InteractiveHistoryEntry,
  type FlowRenderFlowLine as InteractiveHistoryFlowLine,
  renderSnapshotLines,
  SPINNER_FRAMES,
  SPINNER_INTERVAL_MS,
  toTreeFlowStatus,
  toWritableText,
} from './flow/render-model';

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
const DEFAULT_TERMINAL_COLUMNS = 80;
const ANSI_ESCAPE = String.fromCodePoint(0x1b);
const ANSI_PATTERN = new RegExp(
  String.raw`${ANSI_ESCAPE}\[[\d:;<=>?]*[\u0020-\u002F]*[\u0040-\u007E]`,
  'gu',
);

interface FlowTreeNodeInternal {
  children: FlowTreeNodeInternal[];
  depth: number;
  elapsedTimeMs?: number;
  message: string;
  parent?: FlowTreeNodeInternal;
  startedAt?: number;
  status: FlowTreeNodeStatus;
}

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
  return DEFAULT_CI_ENV_VALUES.has(String(env.CI).toLowerCase());
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

function stripControlSequences(text: string): string {
  return text.replaceAll(ANSI_PATTERN, '').replaceAll('\r', '');
}

function isTreeNodeTerminal(node: FlowTreeNodeInternal): boolean {
  return (
    node.status === 'failed' ||
    node.status === 'passed' ||
    node.status === 'skipped'
  );
}

function areTreeNodeDescendantsTerminal(node: FlowTreeNodeInternal): boolean {
  return node.children.every(
    (child) =>
      isTreeNodeTerminal(child) && areTreeNodeDescendantsTerminal(child),
  );
}

export class LiminaFlowReporter {
  readonly #clack: ClackAdapter;
  readonly #interactive: boolean;
  readonly #output: FlowOutput;
  readonly #statusOnly: boolean;
  readonly #stderr: FlowWriteStream | undefined;
  readonly #stdout: FlowWriteStream | undefined;
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
  #terminalColumn = 0;
  #terminalLineCount = 0;

  constructor(options: LiminaFlowReporterOptions = {}) {
    const env = options.env ?? process.env;
    const stdout = options.stdout ?? process.stdout;
    const internalOptions = options as LiminaFlowReporterOptions & {
      [CHECK_FLOW_STATUS_ONLY_OPTION]?: boolean;
    };

    this.#statusOnly = internalOptions[CHECK_FLOW_STATUS_ONLY_OPTION] === true;
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

  #cloneTreeNode(node: FlowTreeNodeInternal): FlowRenderTreeNode {
    return {
      children: node.children.map((child) => this.#cloneTreeNode(child)),
      depth: node.depth,
      elapsedTimeMs: node.elapsedTimeMs,
      message: node.message,
      status: node.status,
    };
  }

  #createRenderSnapshot(): FlowRenderSnapshot {
    return {
      entries: [
        ...this.#interactiveHistory,
        ...this.#processTransientHistory.map(({ entry }) => entry),
      ],
      ...(this.#outroMessage === undefined
        ? {}
        : { outroMessage: this.#outroMessage }),
      treeRoots: this.#treeRoots.map((root) => this.#cloneTreeNode(root)),
    };
  }

  #sendProcessSnapshot(): void {
    if (!this.#processRenderer?.active) {
      return;
    }

    this.#processRenderer.sendSnapshot(this.#createRenderSnapshot());
  }

  #writeRenderSnapshotInline(snapshot: FlowRenderSnapshot): void {
    for (const line of renderSnapshotLines(snapshot, this.#spinnerFrameIndex)) {
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
      this.#recordTerminalWrite(`${message}\n`);
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
    const startLine = this.#terminalLineCount;
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
        const failOptions = {
          ...nextOptions,
          depth,
          elapsedTimeMs:
            nextOptions?.elapsedTimeMs ?? performance.now() - startTime,
        };
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

  tree(
    message: string,
    options: LiminaFlowMessageOptions = {},
  ): LiminaFlowTreeNode {
    const node: FlowTreeNodeInternal = {
      children: [],
      depth: options.depth ?? 0,
      message,
      status: 'planned',
    };

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
    if (this.#statusOnly) {
      return;
    }

    this.#emit('warn', message, options, {
      persistInteractive: options.persistInteractive,
    });
  }

  writeOutput(
    message: string | Uint8Array,
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
        this.#recordTerminalWrite(message);
      }
      (stream.write as (message: string | Uint8Array) => boolean)(message);
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
    if (this.#processRenderer?.active) {
      this.#sendProcessSnapshot();
      return;
    }

    if (this.#terminalLineCount > 0) {
      this.#writeControl(`\r\u001B[${this.#terminalLineCount}A\u001B[J`);
    }

    this.#terminalLineCount = 0;
    this.#terminalColumn = 0;

    for (const entry of this.#interactiveHistory) {
      const lines =
        entry.kind === 'line'
          ? [entry.line]
          : entry.kind === 'flow-line'
            ? [this.#renderInteractiveHistoryFlowLine(entry)]
            : this.#renderTreeLines();

      for (const line of lines) {
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
  }

  #renderInteractiveHistoryFlowLine(entry: InteractiveHistoryFlowLine): string {
    return this.#formatInteractiveLine(
      entry.status,
      formatMessageWithElapsed(entry.message, entry.elapsedTimeMs),
      entry.depth,
    );
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
      child: (message, options = {}) => {
        return this.#createTreeNodeHandle(
          this.#appendTreeChild(node, message, options, {
            redraw: true,
          }),
        );
      },
      children: (messages, options = {}) => {
        const childNodes = messages.map((message) =>
          this.#appendTreeChild(node, message, options, {
            redraw: false,
          }),
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

  #appendTreeChild(
    parent: FlowTreeNodeInternal,
    message: string,
    options: LiminaFlowMessageOptions,
    meta: { redraw: boolean },
  ): FlowTreeNodeInternal {
    const childNode: FlowTreeNodeInternal = {
      children: [],
      depth: options.depth ?? parent.depth + 1,
      message,
      parent,
      status: 'planned',
    };

    parent.children.push(childNode);
    if (meta.redraw) {
      this.#renderTreeChange();
    }

    return childNode;
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
    this.#skipPlannedTreeDescendants(node);

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

  #skipPlannedTreeDescendants(node: FlowTreeNodeInternal): void {
    for (const child of node.children) {
      if (child.status === 'planned') {
        child.status = 'skipped';
      }

      this.#skipPlannedTreeDescendants(child);
    }
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

  #renderTreeLines(): string[] {
    return this.#treeRoots.flatMap((root) => this.#renderTreeNodeLines(root));
  }

  #renderTreeNodeLines(node: FlowTreeNodeInternal): string[] {
    const elapsedTimeMs =
      isTreeNodeTerminal(node) && areTreeNodeDescendantsTerminal(node)
        ? node.elapsedTimeMs
        : undefined;
    const line = this.#formatInteractiveLine(
      toTreeFlowStatus(node.status),
      formatMessageWithElapsed(node.message, elapsedTimeMs),
      node.depth,
    );

    return [
      line,
      ...node.children.flatMap((child) => this.#renderTreeNodeLines(child)),
    ];
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

export function createLiminaCheckFlowReporter(
  options: LiminaFlowReporterOptions = {},
): LiminaFlowReporter {
  return new LiminaFlowReporter({
    ...options,
    [CHECK_FLOW_STATUS_ONLY_OPTION]: true,
  } as LiminaFlowReporterOptions);
}
