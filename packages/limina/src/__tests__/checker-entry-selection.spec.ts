import type { ResolvedLiminaConfig } from '#config/runner';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { glob } from 'tinyglobby';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveCheckerEntrySelection } from '../core/checkers/entry-selection';
import { toPortablePath } from './helpers/path';

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
  exclude: string[];
  include?: string[];
  rootDir: string;
  sourceConfigPaths?: string[];
}) {
  const config: ResolvedLiminaConfig = {
    config: {},
    configPath: path.join(options.rootDir, 'limina.config.mjs'),
    rootDir: options.rootDir,
  };
  const sourceConfigPaths =
    options.sourceConfigPaths ??
    (await glob('**/tsconfig*.json', {
      absolute: true,
      cwd: options.rootDir,
      ignore: baseIgnore,
      onlyFiles: true,
    }));

  return resolveCheckerEntrySelection(
    {
      config,
      sourceConfigPaths,
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

  it('matches parent-relative patterns in config-root coordinates', async () => {
    const fixture = await createFixture();
    const parentPattern = `../${path.basename(fixture.rootDir)}/packages/a/test/tsconfig.json`;

    const selection = await resolveSelection({
      exclude: [parentPattern],
      rootDir: fixture.rootDir,
    });
    const oracle = await collectOracleEffectivePaths({
      exclude: [parentPattern],
      rootDir: fixture.rootDir,
    });
    expect(selection.effectiveEntryPaths).toEqual(oracle);
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

  it('only filters descriptor candidates supplied by activated package islands', async () => {
    const fixture = await createFixture();
    const onlyCandidate = path.join(
      fixture.rootDir,
      'packages/a/tsconfig.json',
    );

    const selection = await resolveSelection({
      exclude: [],
      rootDir: fixture.rootDir,
      sourceConfigPaths: [onlyCandidate],
    });

    expect(selection.includedEntryPaths).toEqual([
      toPortablePath(onlyCandidate),
    ]);
  });

  it('matches external activated-island candidates in config-root coordinates', async () => {
    const fixture = await createFixture();
    const externalRoot = await realpath(
      await mkdtemp(path.join(tmpdir(), 'limina-entry-external-')),
    );
    roots.add(externalRoot);
    const externalConfigPath = path.join(externalRoot, 'tsconfig.json');
    await writeFile(externalConfigPath, '{}\n');
    const include = [
      path
        .relative(fixture.rootDir, externalConfigPath)
        .split(path.sep)
        .join('/'),
    ];

    const selection = await resolveSelection({
      exclude: [],
      include,
      rootDir: fixture.rootDir,
      sourceConfigPaths: [externalConfigPath],
    });

    expect(selection.includedEntryPaths).toEqual([
      toPortablePath(externalConfigPath),
    ]);
    expect(selection.effectiveEntryPaths).toEqual([
      toPortablePath(externalConfigPath),
    ]);
  });
});
