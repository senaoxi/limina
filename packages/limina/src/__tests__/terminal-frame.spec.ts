import { describe, expect, it } from 'vitest';
import { TerminalFrameTracker } from '../flow/terminal-frame';
import { advanceTerminalPosition } from '../flow/terminal-position';

describe('terminal display positions', () => {
  it.each([
    ['ascii', 'abcd', 4, { column: 0, rowsAdvanced: 1 }],
    ['CJK', '你好', 4, { column: 0, rowsAdvanced: 1 }],
    ['emoji', '🙂🙂', 4, { column: 0, rowsAdvanced: 1 }],
    ['combining marks', 'e\u0301e\u0301', 4, { column: 2, rowsAdvanced: 0 }],
    ['ZWJ emoji', '👩\u200D💻', 2, { column: 0, rowsAdvanced: 1 }],
    [
      'ANSI colors',
      '\u001B[31m你好\u001B[0m',
      4,
      { column: 0, rowsAdvanced: 1 },
    ],
    ['narrow terminals', '🙂', 1, { column: 0, rowsAdvanced: 2 }],
    ['newlines', 'ab\ncd', 4, { column: 2, rowsAdvanced: 1 }],
    ['tab stops', 'a\tb', 8, { column: 1, rowsAdvanced: 1 }],
  ])('measures %s by terminal columns', (_label, text, columns, expected) => {
    expect(advanceTerminalPosition(text, columns)).toEqual(expected);
  });

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
