import {
  type FlowWritableChunk,
  stripControlSequences,
  toWritableText,
} from './render-model';

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
  #column = 0;
  #lineCount = 0;
  readonly #getColumns: () => number;

  constructor(getColumns: () => number) {
    this.#getColumns = getColumns;
  }

  get lineCount(): number {
    return this.#lineCount;
  }

  record(chunk: FlowWritableChunk): void {
    const text = stripControlSequences(toWritableText(chunk));
    const columns = Math.max(1, this.#getColumns());

    for (const char of text) {
      if (char === '\n') {
        this.#lineCount += 1;
        this.#column = 0;
        continue;
      }

      this.#column += 1;

      if (this.#column >= columns) {
        this.#lineCount += 1;
        this.#column = 0;
      }
    }
  }

  reset(): void {
    this.#lineCount = 0;
    this.#column = 0;
  }

  setLineCount(lineCount: number): void {
    this.#lineCount = Math.max(0, lineCount);
    this.#column = 0;
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
