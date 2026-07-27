import { type ChildProcess, spawn } from 'node:child_process';
import {
  type InternalProcessEntry,
  resolveInternalProcessEntry,
} from '../execution/internal-process-entry';
import type {
  FlowOutputMessage,
  FlowRendererParentMessage,
  FlowRendererProcessMessage,
  FlowRenderSnapshot,
} from './render-model';
import { toWritableText } from './render-model';
import type {
  FlowWrite,
  FlowWriteArgs,
  FlowWriteCallback,
} from './terminal-frame';
import { writeWithFlowArgs } from './terminal-frame';

type RendererEntry = InternalProcessEntry;

type WriteStreamName = 'stderr' | 'stdout';

function resolveRendererEntry(
  moduleUrl: string = import.meta.url,
): RendererEntry | undefined {
  return resolveInternalProcessEntry({
    bundleFileName: 'flow-renderer-process.js',
    moduleUrl,
    sourceFileName: 'renderer-process.ts',
  });
}

export const resolveRendererEntryForTesting: typeof resolveRendererEntry =
  resolveRendererEntry;

function getWriteCallback(args: FlowWriteArgs): FlowWriteCallback | undefined {
  if (args.length === 3) {
    return args[2];
  }

  if (typeof args[1] === 'function') {
    return args[1];
  }

  return undefined;
}

function callWriteCallback(args: FlowWriteArgs): void {
  const callback = getWriteCallback(args);

  if (callback) {
    queueMicrotask(callback);
  }
}

function getRendererCloseResult(
  message: FlowRendererParentMessage,
): boolean | undefined {
  const results = {
    closed: true,
    failed: false,
    ready: undefined,
  } as const;

  return results[message.type];
}

export class FlowProcessRenderer {
  readonly #child: ChildProcess;
  readonly #ready: Promise<boolean>;
  #restoreStreams: (() => void) | undefined;
  #active = true;
  #closeResolver: ((value: boolean) => void) | undefined;
  #readyResolver: ((value: boolean) => void) | undefined;

  private constructor(child: ChildProcess) {
    this.#child = child;
    this.#ready = new Promise((resolve) => {
      this.#readyResolver = resolve;
    });
    child.on('exit', () => {
      this.#deactivate(false);
    });
    child.on('error', () => {
      this.#deactivate(false);
    });
    child.on('message', (message: FlowRendererParentMessage) => {
      this.#handleParentMessage(message);
    });
  }

  static start(): FlowProcessRenderer | undefined {
    const entry = resolveRendererEntry();

    if (!entry) {
      return undefined;
    }

    const child = spawn(entry.command, entry.args, {
      env: process.env,
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });

    const renderer = new FlowProcessRenderer(child);
    // In real TTY sessions this keeps command output and live flow redraws from
    // fighting over the same terminal frame.
    const restoreStdout = renderer.#patchWriteStream(process.stdout, 'stdout');
    const restoreStderr = renderer.#patchWriteStream(process.stderr, 'stderr');

    renderer.#restoreStreams = () => {
      restoreStdout();
      restoreStderr();
    };

    return renderer;
  }

  get active(): boolean {
    return this.#active;
  }

  get ready(): Promise<boolean> {
    return this.#ready;
  }

  close(snapshot: FlowRenderSnapshot): Promise<boolean> {
    if (!this.active) {
      return Promise.resolve(false);
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.#deactivate(false);
      }, 1000);

      this.#closeResolver = (value) => {
        clearTimeout(timeout);
        resolve(value);
      };
      this.#send({
        snapshot,
        type: 'close',
      });
    });
  }

  sendSnapshot(snapshot: FlowRenderSnapshot): void {
    this.#send({
      snapshot,
      type: 'snapshot',
    });
  }

  writeOutput(output: FlowOutputMessage): void {
    this.#send({
      output,
      type: 'output',
    });
  }

  #handleParentMessage(message: FlowRendererParentMessage): void {
    if (message.type === 'ready') {
      this.#resolveReady(true);
      return;
    }

    const closeResult = getRendererCloseResult(message);

    if (closeResult !== undefined) {
      this.#deactivate(closeResult);
    }
  }

  #shouldKillChild(result: boolean): boolean {
    if (result) {
      return false;
    }

    return [
      !this.#child.killed,
      this.#child.exitCode === null,
      this.#child.signalCode === null,
    ].every(Boolean);
  }

  #restorePatchedStreams(): void {
    const restoreStreams = this.#restoreStreams;
    this.#restoreStreams = undefined;
    restoreStreams?.();
  }

  #resolveClose(result: boolean): void {
    const resolve = this.#closeResolver;
    this.#closeResolver = undefined;
    resolve?.(result);
  }

  #deactivate(result: boolean): void {
    if (!this.#active) {
      return;
    }

    this.#active = false;
    this.#resolveReady(false);
    this.#restorePatchedStreams();

    if (this.#shouldKillChild(result)) {
      this.#child.kill();
    }

    this.#resolveClose(result);
  }

  #resolveReady(result: boolean): void {
    this.#readyResolver?.(result);
    this.#readyResolver = undefined;
  }

  #patchWriteStream(
    stream: NodeJS.WriteStream,
    streamName: WriteStreamName,
  ): () => void {
    const originalWrite = stream.write;

    stream.write = ((...args: FlowWriteArgs) => {
      if (this.active) {
        this.writeOutput({
          stream: streamName,
          text: toWritableText(args[0]),
        });
        callWriteCallback(args);
        return true;
      }

      return writeWithFlowArgs(originalWrite as FlowWrite, args);
    }) as NodeJS.WriteStream['write'];

    return () => {
      stream.write = originalWrite;
    };
  }

  #send(message: FlowRendererProcessMessage): void {
    if (!this.active) {
      return;
    }

    try {
      this.#child.send(message);
    } catch {
      this.#deactivate(false);
    }
  }
}
