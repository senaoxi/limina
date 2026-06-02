import { describe, expect, it } from 'vitest';
import { normalizeAbsolutePathIdentity } from '../utils/path';

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
