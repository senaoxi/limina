import { describe, expect, it } from 'vitest';
import { TerminalFrameTracker } from '../flow/terminal-frame';
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
