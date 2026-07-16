import {
  isPathInsideDirectory,
  normalizeAbsolutePathIdentity,
} from '#utils/path';
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

  it('normalizes UNC separators without changing path casing', () => {
    expect(normalizeAbsolutePathIdentity('\\\\server\\share\\Repo\\')).toBe(
      '//server/share/Repo',
    );
  });
});

describe('isPathInsideDirectory', () => {
  it('accepts the directory itself and nested files', () => {
    expect(isPathInsideDirectory('/repo/project', '/repo/project')).toBe(true);
    expect(
      isPathInsideDirectory('/repo/project/src/index.ts', '/repo/project'),
    ).toBe(true);
  });

  it('rejects sibling paths with matching prefixes', () => {
    expect(
      isPathInsideDirectory('/repo/project-other/file.ts', '/repo/project'),
    ).toBe(false);
  });

  it('handles filesystem roots without double-slash prefix checks', () => {
    expect(isPathInsideDirectory('/repo/project/file.ts', '/')).toBe(true);
    expect(isPathInsideDirectory('C:/repo/project/file.ts', 'C:/')).toBe(true);
  });

  it('does not reject valid child names that start with dots', () => {
    expect(
      isPathInsideDirectory('/repo/project/..build/file.ts', '/repo/project'),
    ).toBe(true);
  });

  it('rejects paths outside the directory and Windows drive boundaries', () => {
    expect(
      isPathInsideDirectory('/repo/project/../other/file.ts', '/repo/project'),
    ).toBe(false);
    expect(
      isPathInsideDirectory('D:/repo/project/file.ts', 'C:/repo/project'),
    ).toBe(false);
  });

  it('handles UNC shares segment-by-segment without filesystem access', () => {
    expect(
      isPathInsideDirectory(
        '//server/share/repo/packages/app',
        '//server/share/repo',
      ),
    ).toBe(true);
    expect(
      isPathInsideDirectory(
        '//server/share-other/repo/packages/app',
        '//server/share/repo',
      ),
    ).toBe(false);
  });
});
