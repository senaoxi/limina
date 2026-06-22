import type { ResolvedLiminaConfig } from '#config/runner';
import type { PnpmWorkspaceListEntry } from '#core/workspace/actions';
import {
  collectPnpmWorkspacePatterns,
  collectWorkspacePackages,
  parsePnpmWorkspaceListJson,
} from '#core/workspace/actions';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toPortableRelativePath } from './helpers/path';

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

async function writeText(filePath: string, text: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text);
}

function stringifyConfig(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function mockPnpmListResult(entries: PnpmWorkspaceListEntry[]): void {
  execFileMock.mockImplementation(
    (
      _command: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string) => void,
    ) => {
      callback(null, JSON.stringify(entries));
      return {};
    },
  );
}

function mockPnpmListFailure(error: Error): void {
  execFileMock.mockImplementation(
    (
      _command: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string) => void,
    ) => {
      callback(error, '');
      return {};
    },
  );
}

function expectPnpmListCommand(rootDir: string): void {
  const [, args, options] = execFileMock.mock.calls[0] as [
    command: string,
    args: string[],
    options: { cwd?: string },
    callback: unknown,
  ];

  expect(args.slice(-5)).toEqual([
    'recursive',
    'list',
    '--depth',
    '-1',
    '--json',
  ]);
  expect(options).toEqual(expect.objectContaining({ cwd: rootDir }));
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

beforeEach(() => {
  execFileMock.mockReset();
});

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
  it('collects workspace packages without names', async () => {
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
      mockPnpmListResult([
        {
          path: fixture.rootDir,
        },
        {
          path: path.join(fixture.rootDir, 'packages/a'),
        },
      ]);

      const packages = await collectWorkspacePackages(fixture.config);

      expect(
        packages.map((workspacePackage) => ({
          directory: toPortableRelativePath(
            fixture.rootDir,
            workspacePackage.directory,
          ),
          name: workspacePackage.name,
        })),
      ).toEqual(
        expect.arrayContaining([
          {
            directory: '',
            name: 'root',
          },
          {
            directory: 'packages/a',
            name: undefined,
          },
        ]),
      );
      expectPnpmListCommand(fixture.rootDir);
    } finally {
      await fixture.cleanup();
    }
  });

  it('treats blank workspace package names as nameless and keeps deterministic order', async () => {
    const fixture = await createFixture({
      'package.json': stringifyConfig({
        name: 'root',
        private: true,
        workspaces: ['packages/*'],
      }),
      'packages/a/package.json': stringifyConfig({
        name: '@example/a',
        private: true,
      }),
      'packages/b/package.json': stringifyConfig({
        name: '   ',
        private: true,
      }),
      'packages/z/package.json': stringifyConfig({
        name: '@example/z',
        private: true,
      }),
    });

    try {
      mockPnpmListResult([
        {
          path: fixture.rootDir,
        },
        {
          path: path.join(fixture.rootDir, 'packages/z'),
        },
        {
          path: path.join(fixture.rootDir, 'packages/b'),
        },
        {
          path: path.join(fixture.rootDir, 'packages/a'),
        },
      ]);

      const packages = await collectWorkspacePackages(fixture.config);

      expect(
        packages.map((workspacePackage) => ({
          directory: toPortableRelativePath(
            fixture.rootDir,
            workspacePackage.directory,
          ),
          name: workspacePackage.name,
        })),
      ).toEqual([
        {
          directory: 'packages/a',
          name: '@example/a',
        },
        {
          directory: 'packages/z',
          name: '@example/z',
        },
        {
          directory: '',
          name: 'root',
        },
        {
          directory: 'packages/b',
          name: undefined,
        },
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not fall back to workspace globs when pnpm list omits a package', async () => {
    const fixture = await createFixture({
      'package.json': stringifyConfig({
        name: 'root',
        private: true,
        workspaces: ['packages/*'],
      }),
      'packages/a/package.json': stringifyConfig({
        name: '@example/a',
        private: true,
      }),
    });

    try {
      mockPnpmListResult([
        {
          path: fixture.rootDir,
        },
      ]);

      const packages = await collectWorkspacePackages(fixture.config);

      expect(
        packages.map((workspacePackage) => ({
          directory: toPortableRelativePath(
            fixture.rootDir,
            workspacePackage.directory,
          ),
          name: workspacePackage.name,
        })),
      ).toEqual([
        {
          directory: '',
          name: 'root',
        },
      ]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('reports pnpm list failures instead of falling back to workspace globs', async () => {
    const fixture = await createFixture({
      'package.json': stringifyConfig({
        name: 'root',
        private: true,
        workspaces: ['packages/*'],
      }),
      'packages/a/package.json': stringifyConfig({
        name: '@example/a',
        private: true,
      }),
    });

    try {
      mockPnpmListFailure(new Error('pnpm list unavailable'));

      await expect(collectWorkspacePackages(fixture.config)).rejects.toThrow(
        /Failed to collect workspace packages via pnpm recursive list\.[\s\S]*pnpm list unavailable/u,
      );
    } finally {
      await fixture.cleanup();
    }
  });
});
