import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLiminaFlowReporter } from '../flow';
import { patchWriteStream, TerminalFrameTracker } from '../flow/terminal-frame';
import { advanceTerminalPosition } from '../flow/terminal-position';

interface TerminalPositionCase {
  columns: number;
  expected: { column: number; rowsAdvanced: number };
  label: string;
  text: string;
}

const terminalPositionCases: TerminalPositionCase[] = [
  {
    columns: 4,
    expected: { column: 0, rowsAdvanced: 1 },
    label: 'ascii',
    text: 'abcd',
  },
  {
    columns: 4,
    expected: { column: 0, rowsAdvanced: 1 },
    label: 'CJK',
    text: '你好',
  },
  {
    columns: 4,
    expected: { column: 0, rowsAdvanced: 1 },
    label: 'emoji',
    text: '🙂🙂',
  },
  {
    columns: 4,
    expected: { column: 2, rowsAdvanced: 0 },
    label: 'combining marks',
    text: 'e\u0301e\u0301',
  },
  {
    columns: 2,
    expected: { column: 0, rowsAdvanced: 1 },
    label: 'ZWJ emoji',
    text: '👩\u200D💻',
  },
  {
    columns: 4,
    expected: { column: 0, rowsAdvanced: 1 },
    label: 'ANSI colors',
    text: '\u001B[31m你好\u001B[0m',
  },
  {
    columns: 1,
    expected: { column: 0, rowsAdvanced: 2 },
    label: 'narrow terminals',
    text: '🙂',
  },
  {
    columns: 4,
    expected: { column: 2, rowsAdvanced: 1 },
    label: 'newlines',
    text: 'ab\ncd',
  },
  {
    columns: 8,
    expected: { column: 1, rowsAdvanced: 1 },
    label: 'tab stops',
    text: 'a\tb',
  },
];

describe('terminal display positions', () => {
  it.each(terminalPositionCases)(
    'measures $label by terminal columns',
    ({ columns, expected, text }) => {
      expect(advanceTerminalPosition(text, columns)).toEqual(expected);
    },
  );

  it('tracks split UTF-8 buffers without replacement characters', () => {
    const tracker = new TerminalFrameTracker(() => 4);
    const bytes = Buffer.from('你好');
    tracker.record(bytes.subarray(0, 2));
    tracker.record(bytes.subarray(2, 5));
    tracker.record(bytes.subarray(5));
    expect(tracker.lineCount).toBe(1);
  });

  it('keeps split ANSI and OSC sequences out of frame widths', () => {
    const tracker = new TerminalFrameTracker(() => 4);
    tracker.record('\u001B[');
    expect(tracker.lineCount).toBe(0);
    tracker.record('31m你');
    tracker.record('\u001B]0;title');
    tracker.record('\u001B\\好');
    expect(tracker.lineCount).toBe(1);
  });

  it('recomputes an unfinished grapheme across writes', () => {
    const tracker = new TerminalFrameTracker(() => 3);
    tracker.record('👩');
    expect(tracker.lineCount).toBe(0);
    tracker.record('\u200D💻');
    expect(tracker.lineCount).toBe(0);
  });

  it('preserves explicit line counts across resets', () => {
    const tracker = new TerminalFrameTracker(() => 4);
    tracker.record('abcd\n');
    expect(tracker.lineCount).toBe(2);
    tracker.setLineCount(3);
    expect(tracker.lineCount).toBe(3);
    tracker.reset();
    expect(tracker.lineCount).toBe(0);
  });
});

describe('real Writable stream tracking', () => {
  it.each([
    { chunk: 'é', encoding: 'latin1' as const, hex: 'e9' },
    { chunk: Buffer.from([0, 255]), encoding: undefined, hex: '00ff' },
  ])(
    'preserves the receiver, bytes, callback and backpressure for $hex',
    async ({ chunk, encoding, hex }) => {
      const writes: string[] = [];
      const stream = new Writable({
        highWaterMark: 1,
        write(bytes, _encoding, done) {
          writes.push(bytes.toString('hex'));
          setImmediate(done);
        },
      });
      const original = stream.write;
      const observed: unknown[] = [];
      const restore = patchWriteStream(stream, (value) => observed.push(value));
      let returned = true;
      let callbacks = 0;
      try {
        await new Promise<void>((resolve, reject) => {
          const done = (error?: Error | null) => {
            callbacks++;
            if (error) reject(error);
            else resolve();
          };
          returned = encoding
            ? stream.write(chunk, encoding, done)
            : stream.write(chunk, done);
        });
        expect(returned).toBe(false);
        expect(callbacks).toBe(1);
        expect(writes).toEqual([hex]);
        expect(observed).toEqual([chunk]);
        restore?.();
        expect(stream.write).toBe(original);
      } finally {
        restore?.();
        stream.destroy();
      }
    },
  );

  it.each([false, true])(
    'renders and restores real streams (shared: %s)',
    async (shared) => {
      const chunks: string[] = [];
      const stream = new Writable({
        write(chunk, _encoding, done) {
          chunks.push(String(chunk));
          done();
        },
      });
      const original = stream.write;
      const stderr = shared
        ? stream
        : new Writable({
            write(_chunk, _encoding, done) {
              done();
            },
          });
      const originalStderr = stderr.write;
      const flow = createLiminaFlowReporter({
        stdout: stream,
        stderr,
        forceTty: true,
        renderer: 'inline',
      });
      try {
        const task = flow.start('rendered task');
        task.pass();
        await flow.close();
        expect(chunks.join('')).toContain('rendered task');
        expect(stream.write).toBe(original);
        expect(stderr.write).toBe(originalStderr);
      } finally {
        stream.write = original;
        await flow.close();
        stream.destroy();
        stderr.destroy();
      }
    },
  );
});
