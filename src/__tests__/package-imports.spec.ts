import { describe, expect, it } from 'vitest';
import { findPackageImportMatch } from '../core/packages/authority';

describe('findPackageImportMatch', () => {
  it('prefers an exact key over an earlier wildcard', () => {
    expect(
      findPackageImportMatch(
        {
          '#*': './src/*.ts',
          '#internal': 'external-package',
        },
        '#internal',
      ),
    ).toEqual({
      key: '#internal',
      targetKind: 'package',
      value: 'external-package',
    });
  });

  it.each([
    {
      '#*': 'broad-package',
      '#internal/*': './src/internal/*.ts',
      '#internal/*.js': ['./src/*.js', 'external-package'],
    },
    {
      '#internal/*.js': ['./src/*.js', 'external-package'],
      '#internal/*': './src/internal/*.ts',
      '#*': 'broad-package',
    },
  ])('selects the most specific matching pattern', (importsField) => {
    expect(findPackageImportMatch(importsField, '#internal/value.js')).toEqual({
      key: '#internal/*.js',
      targetKind: 'mixed',
      value: ['./src/*.js', 'external-package'],
    });
  });

  it.each([
    ['./src/internal.ts', 'relative'],
    ['external-package', 'package'],
    [['./src/internal.ts', 'external-package'], 'mixed'],
    [null, 'unknown'],
  ] as const)(
    'preserves raw target classification for %j',
    (value, targetKind) => {
      expect(
        findPackageImportMatch({ '#internal': value }, '#internal'),
      ).toEqual({
        key: '#internal',
        targetKind,
        value,
      });
    },
  );
});
