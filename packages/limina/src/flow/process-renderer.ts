import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'pathe';
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

interface RendererEntry {
  args: string[];
  command: string;
}

type WriteStreamName = 'stderr' | 'stdout';

function findTsxBinary(packageDir: string): string {
  const tsxBinName = process.platform === 'win32' ? 'tsx.cmd' : 'tsx';

  return (
    [
      path.join(packageDir, 'node_modules/.bin', tsxBinName),
      path.join(packageDir, '../../node_modules/.bin', tsxBinName),
    ].find((candidate) => existsSync(candidate)) ?? 'tsx'
  );
}

function resolveRendererEntry(): RendererEntry | undefined {
  const currentDir = fileURLToPath(new URL('.', import.meta.url));
  const sourceEntries = [
    path.resolve(currentDir, 'flow/renderer-process.ts'),
    path.resolve(process.cwd(), 'src/flow/renderer-process.ts'),
  ];
  const distEntries = [
    path.resolve(currentDir, 'flow-renderer-process.js'),
    path.resolve(currentDir, '../flow-renderer-process.js'),
    path.resolve(process.cwd(), 'dist/flow-renderer-process.js'),
  ];
  const sourceEntry = sourceEntries.find((candidate) => existsSync(candidate));

  if (sourceEntry) {
    return {
      args: [sourceEntry],
      command: findTsxBinary(path.resolve(path.dirname(sourceEntry), '../..')),
    };
  }

  const distEntry = distEntries.find((candidate) => existsSync(candidate));

  if (distEntry) {
    return {
      args: [distEntry],
      command: process.execPath,
    };
  }

  return undefined;
}

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
      if (message.type === 'ready') {
        this.#resolveReady(true);
        return;
      }

      if (message.type === 'closed' || message.type === 'failed') {
        this.#deactivate(message.type === 'closed');
      }
    });
  }

  static start(): FlowProcessRenderer | undefined {
    const entry = resolveRendererEntry();

    if (!entry) {
      return undefined;
    }

    const child = spawn(entry.command, entry.args, {
      env: process.env,
      shell: process.platform === 'win32',
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

  #deactivate(result: boolean): void {
    if (!this.#active) {
      return;
    }

    this.#active = false;
    this.#resolveReady(false);
    this.#restoreStreams?.();
    if (
      !result &&
      !this.#child.killed &&
      this.#child.exitCode === null &&
      this.#child.signalCode === null
    ) {
      this.#child.kill();
    }
    this.#closeResolver?.(result);
    this.#closeResolver = undefined;
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
