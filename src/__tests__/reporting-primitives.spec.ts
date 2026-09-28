import { describe, expect, it } from 'vitest';
import { countDefinedBy } from '../utils/collections';
import { colorText, plural, resolveColorEnabled } from '../utils/reporting';

describe('reporting primitives', () => {
  it('selects singular and plural labels', () => {
    expect(plural(1, 'issue', 'issues')).toBe('issue');
    expect(plural(0, 'issue', 'issues')).toBe('issues');
    expect(plural(2, 'issue', 'issues')).toBe('issues');
  });

  it('wraps a single ANSI style with a reset', () => {
    expect(colorText('\u001B[31m', 'failed')).toBe('\u001B[31mfailed\u001B[0m');
  });

  it('resolves color support from explicit environment and TTY inputs', () => {
    expect(
      resolveColorEnabled({ env: { FORCE_COLOR: '1' }, isTTY: false }),
    ).toBe(true);
    expect(
      resolveColorEnabled({ env: { FORCE_COLOR: '0' }, isTTY: true }),
    ).toBe(false);
    expect(resolveColorEnabled({ env: { NO_COLOR: '1' }, isTTY: true })).toBe(
      false,
    );
    expect(resolveColorEnabled({ env: {}, isTTY: true })).toBe(true);
    expect(resolveColorEnabled({ env: {}, isTTY: false })).toBe(false);
  });

  it('counts non-empty selected values in encounter order', () => {
    const values = ['alpha', '', undefined, 'beta', null, 'alpha'];

    expect([...countDefinedBy(values, (value) => value)]).toEqual([
      ['alpha', 2],
      ['beta', 1],
    ]);
  });
});
