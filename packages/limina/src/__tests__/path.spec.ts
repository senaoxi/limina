import { normalizeAbsolutePathIdentity } from '#utils/path';
import { describe, expect, it } from 'vitest';

describe('normalizeAbsolutePathIdentity', () => {
  it('normalizes Windows separators and trailing separators', () => {
    expect(normalizeAbsolutePathIdentity('C:\\repo\\docs-islands\\')).toBe(
      'C:/repo/docs-islands',
    );
    expect(normalizeAbsolutePathIdentity('C:/repo/docs-islands')).toBe(
      'C:/repo/docs-islands',
    );
    expect(normalizeAbsolutePathIdentity('C:\\')).toBe('C:/');
  });
});
