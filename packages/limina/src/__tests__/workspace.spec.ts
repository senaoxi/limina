import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ResolvedLiminaConfig } from '../config';
import {
  collectPnpmWorkspacePatterns,
  collectWorkspacePackages,
  parsePnpmWorkspaceListJson,
} from '../workspace';

async function writeText(filePath: string, text: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text);
}

function stringifyConfig(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function createFixture(files: Record<string, string>): Promise<{
  cleanup: () => Promise<void>;
  config: ResolvedLiminaConfig;
  rootDir: string;
}> {
  const rootDir = await realpath(
    await mkdtemp(path.join(tmpdir(), 'limina-workspace-')),
  );

  for (const [relativePath, text] of Object.entries(files)) {
    await writeText(path.join(rootDir, relativePath), text);
  }

  return {
    cleanup: async () => {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    },
    config: {
      configPath: path.join(rootDir, 'limina.config.mjs'),
      rootDir,
    },
    rootDir,
  };
}

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
  it('reads package paths from pnpm recursive list json', () => {
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
      {
        path: '/repo/packages/unnamed',
      },
    ]);
  });
});

describe('collectWorkspacePackages', () => {
  it('fails when a workspace package has no name', async () => {
    const fixture = await createFixture({
      'package.json': stringifyConfig({
        name: 'root',
        private: true,
        workspaces: ['packages/*'],
      }),
      'packages/a/package.json': stringifyConfig({
        private: true,
      }),
    });

    try {
      await expect(collectWorkspacePackages(fixture.config)).rejects.toThrow(
        /Workspace package package\.json must declare a non-empty name:[\s\S]*packages\/a\/package\.json/u,
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('fails when a workspace package name is blank', async () => {
    const fixture = await createFixture({
      'package.json': stringifyConfig({
        name: 'root',
        private: true,
        workspaces: ['packages/*'],
      }),
      'packages/a/package.json': stringifyConfig({
        name: '   ',
        private: true,
      }),
    });

    try {
      await expect(collectWorkspacePackages(fixture.config)).rejects.toThrow(
        /field: name/u,
      );
    } finally {
      await fixture.cleanup();
    }
  });
});
