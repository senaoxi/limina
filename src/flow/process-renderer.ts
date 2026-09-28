import { type ChildProcess, spawn } from 'node:child_process';
import {
  type InternalProcessEntry,
  resolveInternalProcessEntry,
} from '../execution/internal-process-entry';
import { patchRendererWriteStream } from './process-renderer-stream';
import type {
  FlowOutputMessage,
  FlowRendererParentMessage,
  FlowRendererProcessMessage,
  FlowRenderSnapshot,
} from './render-model';

type RendererEntry = InternalProcessEntry;

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

function getRendererCloseResult(
  message: FlowRendererParentMessage,
): boolean | undefined {
  const results = {
    closed: true,
    failed: false,
    ready: undefined,
    suspended: undefined,
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
  #suspendPromise: Promise<boolean> | undefined;
  #suspendResolver: ((value: boolean) => void) | undefined;

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
    renderer.#patchWriteStreams();

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

  suspend(): Promise<boolean> {
    if (!this.active) {
      return Promise.resolve(false);
    }
    if (this.#suspendPromise !== undefined) {
      return this.#suspendPromise;
    }

    this.#suspendPromise = new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.#deactivate(false);
      }, 1000);

      this.#suspendResolver = (value) => {
        clearTimeout(timeout);
        this.#suspendPromise = undefined;
        resolve(value);
      };
      this.#send({ type: 'suspend' });
    });
    return this.#suspendPromise;
  }

  resume(snapshot: FlowRenderSnapshot): void {
    if (!this.active) return;
    this.#patchWriteStreams();
    this.#send({ snapshot, type: 'resume' });
  }

  writeOutput(output: FlowOutputMessage): void {
    this.#send({
      output,
      type: 'output',
    });
  }

  #handleParentMessage(message: FlowRendererParentMessage): void {
    const closeResult = getRendererCloseResult(message);
    if (closeResult !== undefined) {
      this.#deactivate(closeResult);
      return;
    }
    this.#handleRendererStateMessage(message);
  }

  #handleRendererStateMessage(message: FlowRendererParentMessage): void {
    if (message.type === 'ready') {
      this.#resolveReady(true);
      return;
    }
    if (message.type === 'suspended') {
      this.#restorePatchedStreams();
      this.#resolveSuspend(true);
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
    this.#resolveSuspend(false);

    if (this.#shouldKillChild(result)) {
      this.#child.kill();
    }

    this.#resolveClose(result);
  }

  #resolveReady(result: boolean): void {
    this.#readyResolver?.(result);
    this.#readyResolver = undefined;
  }

  #resolveSuspend(result: boolean): void {
    const resolve = this.#suspendResolver;
    this.#suspendResolver = undefined;
    resolve?.(result);
  }

  #patchWriteStreams(): void {
    if (this.#restoreStreams !== undefined) return;
    // In real TTY sessions this keeps command output and live flow redraws from
    // fighting over the same terminal frame.
    const patch = (
      stream: NodeJS.WriteStream,
      streamName: 'stderr' | 'stdout',
    ) =>
      patchRendererWriteStream({
        active: () => this.active,
        output: (output) => this.writeOutput(output),
        stream,
        streamName,
      });
    const restoreStdout = patch(process.stdout, 'stdout');
    const restoreStderr = patch(process.stderr, 'stderr');

    this.#restoreStreams = () => {
      restoreStdout();
      restoreStderr();
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
