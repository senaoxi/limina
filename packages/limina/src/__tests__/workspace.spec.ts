import { describe, expect, it } from 'vitest';
import {
  collectPnpmWorkspacePatterns,
  parsePnpmWorkspaceListJson,
} from '../workspace';

describe('collectPnpmWorkspacePatterns', () => {
  it('reads package globs from the pnpm workspace packages section', () => {
    expect(
      collectPnpmWorkspacePatterns(`
packages:
  - packages/*
  - 'docs'
  - "!**/dist"

catalogs:
  dev:
    typescript: 5.9.3
`),
    ).toEqual(['packages/*', 'docs', '!**/dist']);
  });
});

describe('parsePnpmWorkspaceListJson', () => {
  it('reads named package paths from pnpm recursive list json', () => {
    expect(
      parsePnpmWorkspaceListJson(
        JSON.stringify([
          {
            name: 'root',
            path: '/repo',
            private: true,
          },
          {
            name: '@example/a',
            path: '/repo/packages/a',
            version: '1.0.0',
          },
          {
            path: '/repo/packages/unnamed',
          },
        ]),
      ),
    ).toEqual([
      {
        name: 'root',
        path: '/repo',
      },
      {
        name: '@example/a',
        path: '/repo/packages/a',
      },
    ]);
  });
});
