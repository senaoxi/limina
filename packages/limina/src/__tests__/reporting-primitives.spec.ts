import { describe, expect, it } from 'vitest';
import { countDefinedBy } from '../utils/collections';
import { colorText, plural } from '../utils/reporting';

describe('reporting primitives', () => {
  it('selects singular and plural labels', () => {
    expect(plural(1, 'issue', 'issues')).toBe('issue');
    expect(plural(0, 'issue', 'issues')).toBe('issues');
    expect(plural(2, 'issue', 'issues')).toBe('issues');
  });

  it('wraps a single ANSI style with a reset', () => {
    expect(colorText('\u001B[31m', 'failed')).toBe('\u001B[31mfailed\u001B[0m');
  });

  it('counts non-empty selected values in encounter order', () => {
    const values = ['alpha', '', undefined, 'beta', null, 'alpha'];

    expect([...countDefinedBy(values, (value) => value)]).toEqual([
      ['alpha', 2],
      ['beta', 1],
    ]);
  });
});
