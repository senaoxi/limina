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

export type FlowWriteArguments =
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
  const forwardWrite = originalWrite.bind(stream);

  const isPatchedWrite = (...arguments_: FlowWriteArguments): boolean => {
    onWrite(arguments_[0]);

    return isWriteWithFlowArguments(forwardWrite, arguments_);
  };

  stream.write = isPatchedWrite as FlowWrite;

  return () => {
    stream.write = originalWrite;
  };
}

export function isWriteWithFlowArguments(
  isWrite: FlowWrite,
  arguments_: FlowWriteArguments,
): boolean {
  return typeof arguments_[1] === 'string'
    ? isWrite(arguments_[0], arguments_[1], arguments_[2])
    : isWrite(arguments_[0], arguments_[1]);
}
