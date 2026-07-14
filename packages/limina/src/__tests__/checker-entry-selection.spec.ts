import type { ResolvedLiminaConfig } from '#config/runner';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { glob } from 'tinyglobby';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type CheckerEntryDiscovery,
  resolveCheckerEntrySelection,
} from '../core/checkers/entry-selection';
import { createWorkspaceActivatedRegionIndex } from '../core/workspace/regions';

const roots = new Set<string>();
const baseIgnore = [
  '**/.git/**',
  '**/.limina/**',
  '**/.tsbuild/**',
  '**/coverage/**',
  '**/dist/**',
  '**/node_modules/**',
];

async function createFixture(): Promise<{
  config: ResolvedLiminaConfig;
  rootDir: string;
}> {
  const rootDir = await realpath(
    await mkdtemp(path.join(tmpdir(), 'limina-entry-selection-')),
  );
  roots.add(rootDir);
  const files = [
    'packages/a/tsconfig.json',
    'packages/a/test/tsconfig.json',
    'packages/a/.hidden/tsconfig.json',
    'packages/literal!/tsconfig.json',
    'packages/escaped[dir]/tsconfig.json',
  ];

  for (const relativePath of files) {
    const filePath = path.join(rootDir, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, '{}\n');
  }

  return {
    config: {
      config: {},
      configPath: path.join(rootDir, 'limina.config.mjs'),
      rootDir,
    },
    rootDir,
  };
}

async function resolveSelection(options: {
  discover?: CheckerEntryDiscovery;
  exclude: string[];
  include?: string[];
  rootDir: string;
}) {
  const config: ResolvedLiminaConfig = {
    config: {},
    configPath: path.join(options.rootDir, 'limina.config.mjs'),
    rootDir: options.rootDir,
  };
  const activatedRegions = createWorkspaceActivatedRegionIndex({
    packages: [
      {
        directory: options.rootDir,
        manifest: { name: 'root', private: true },
        name: 'root',
      },
    ],
    rootDir: options.rootDir,
  });

  return resolveCheckerEntrySelection(
    {
      activatedRegions,
      config,
      discover: options.discover,
      regionBoundaries: [],
    },
    {
      checkerName: 'typescript',
      exclude: options.exclude,
      include: options.include ?? ['**/tsconfig.json'],
    },
  );
}

async function collectOracleEffectivePaths(options: {
  exclude: string[];
  include?: string[];
  rootDir: string;
}): Promise<string[]> {
  const included = await glob(options.include ?? ['**/tsconfig.json'], {
    absolute: true,
    cwd: options.rootDir,
    ignore: baseIgnore,
    onlyFiles: true,
  });
  const excluded = new Set(
    await glob(options.exclude, {
      absolute: true,
      cwd: options.rootDir,
      ignore: baseIgnore,
      onlyFiles: true,
    }),
  );

  return included
    .filter((filePath) => !excluded.has(filePath))
    .sort((left, right) => left.localeCompare(right));
}

afterEach(async () => {
  for (const rootDir of roots) {
    await rm(rootDir, { force: true, recursive: true });
  }
  roots.clear();
});

describe('checker entry selection', () => {
  it.each([
    ['positive only', ['packages/a/test/tsconfig.json']],
    [
      'positive plus negative',
      ['packages/a/**/tsconfig.json', '!packages/a/test/**'],
    ],
    ['negative only', ['!packages/a/test/**']],
    [
      'negative order does not re-include',
      ['!packages/a/test/**', 'packages/a/**/tsconfig.json'],
    ],
    ['double bang', ['!!packages/a/tsconfig.json']],
    ['double bang extglob', ['!!(packages/a/tsconfig.json)']],
    ['triple bang', ['!!!packages/a/tsconfig.json']],
    ['positive extglob', ['!(packages/a/tsconfig.json)']],
    ['trailing slash', ['packages/a/test/']],
    ['exact file expansion', ['packages/a/tsconfig.json']],
    ['escaped bang', [String.raw`packages/literal\!/tsconfig.json`]],
    [
      'escaped metacharacters',
      [String.raw`packages/escaped\[dir\]/tsconfig.json`],
    ],
  ])('matches the tinyglobby oracle for %s', async (_label, exclude) => {
    const fixture = await createFixture();
    const selection = await resolveSelection({
      exclude,
      rootDir: fixture.rootDir,
    });
    const oracle = await collectOracleEffectivePaths({
      exclude,
      rootDir: fixture.rootDir,
    });

    expect(selection.effectiveEntryPaths).toEqual(oracle);
  });

  it('matches absolute and parent-relative patterns that resolve into the workspace', async () => {
    const fixture = await createFixture();
    const absolutePattern = path.join(
      fixture.rootDir,
      'packages/a/tsconfig.json',
    );
    const parentPattern = `../${path.basename(fixture.rootDir)}/packages/a/test/tsconfig.json`;

    for (const exclude of [[absolutePattern], [parentPattern]]) {
      const selection = await resolveSelection({
        exclude,
        rootDir: fixture.rootDir,
      });
      const oracle = await collectOracleEffectivePaths({
        exclude,
        rootDir: fixture.rootDir,
      });
      expect(selection.effectiveEntryPaths).toEqual(oracle);
    }
  });

  it('validates non-entry matches before applying exclude', async () => {
    const fixture = await createFixture();
    const invalidPath = path.join(
      fixture.rootDir,
      'packages/a/tsconfig.test.json',
    );
    await writeFile(invalidPath, '{}\n');

    await expect(
      resolveSelection({
        exclude: ['**/tsconfig.test.json'],
        include: ['**/tsconfig*.json'],
        rootDir: fixture.rootDir,
      }),
    ).rejects.toThrow(/Checker include matched non-entry/u);
  });

  it('performs one include discovery per selector invocation', async () => {
    const fixture = await createFixture();
    const discover = vi.fn<CheckerEntryDiscovery>(async (patterns, options) =>
      glob(patterns as string[], options),
    );

    await resolveSelection({
      discover,
      exclude: ['packages/a/test/**'],
      rootDir: fixture.rootDir,
    });

    expect(discover).toHaveBeenCalledOnce();
  });
});
