import type { FlowWritableChunk } from './render-model';
import {
  advanceTerminalPosition,
  TerminalTextStream,
} from './terminal-position';

export const DEFAULT_TERMINAL_COLUMNS = 80;

export type FlowWriteCallback = (error?: Error | null) => void;
export interface FlowWrite {
  (chunk: FlowWritableChunk, callback?: FlowWriteCallback): boolean;
  (
    chunk: FlowWritableChunk,
    encoding: BufferEncoding,
    callback?: FlowWriteCallback,
  ): boolean;
}

export type FlowWriteArgs =
  | [chunk: FlowWritableChunk, callback?: FlowWriteCallback]
  | [
      chunk: FlowWritableChunk,
      encoding: BufferEncoding,
      callback?: FlowWriteCallback,
    ];

export interface FlowWriteStream {
  columns?: number;
  isTTY?: boolean;
  rows?: number;
  write?: FlowWrite;
}

export class TerminalFrameTracker {
  #completedLineCount = 0;
  #currentLine = '';
  readonly #textStream = new TerminalTextStream();
  readonly #getColumns: () => number;

  constructor(getColumns: () => number) {
    this.#getColumns = getColumns;
  }

  get lineCount(): number {
    return (
      this.#completedLineCount +
      advanceTerminalPosition(
        this.#currentLine,
        Math.max(1, this.#getColumns()),
      ).rowsAdvanced
    );
  }

  record(chunk: FlowWritableChunk): void {
    const text = this.#textStream.decode(chunk);
    const columns = Math.max(1, this.#getColumns());
    const lines = text.split('\n');

    this.#currentLine += lines.shift() ?? '';

    for (const line of lines) {
      this.#completedLineCount +=
        advanceTerminalPosition(this.#currentLine, columns).rowsAdvanced + 1;
      this.#currentLine = line;
    }
  }

  reset(): void {
    this.#completedLineCount = 0;
    this.#currentLine = '';
    this.#textStream.reset();
  }

  setLineCount(lineCount: number): void {
    this.#completedLineCount = Math.max(0, lineCount);
    this.#currentLine = '';
    this.#textStream.reset();
  }
}

export function patchWriteStream(
  stream: FlowWriteStream | undefined,
  onWrite: (chunk: FlowWritableChunk) => void,
): (() => void) | undefined {
  if (typeof stream?.write !== 'function') {
    return undefined;
  }

  const originalWrite = stream.write;

  const patchedWrite = (...args: FlowWriteArgs): boolean => {
    onWrite(args[0]);

    return writeWithFlowArgs(originalWrite, args);
  };

  stream.write = patchedWrite as FlowWrite;

  return () => {
    stream.write = originalWrite;
  };
}

export function writeWithFlowArgs(
  write: FlowWrite,
  args: FlowWriteArgs,
): boolean {
  if (typeof args[1] === 'string') {
    return write(args[0], args[1], args[2]);
  }

  return write(args[0], args[1]);
}
