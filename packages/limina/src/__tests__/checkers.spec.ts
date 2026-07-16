import {
  clearCheckerProjectConfigCache,
  parseCheckerProjectConfigForContext,
  resolveModuleNameWithCheckersDetailed,
} from '#checkers';
import type { CheckerPreset } from '#config/runner';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProfilingMetricsRecorder } from '../profiling/metrics';
import { toPortablePath, toPortableRelativePaths } from './helpers/path';

async function writeText(filePath: string, text: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text);
}

async function createFixture(files: Record<string, string>): Promise<{
  cleanup: () => Promise<void>;
  rootDir: string;
}> {
  const rootDir = await realpath(
    await mkdtemp(path.join(tmpdir(), 'limina-checkers-')),
  );

  for (const [relativePath, text] of Object.entries(files)) {
    await writeText(path.join(rootDir, relativePath), text);
  }

  return {
    cleanup: async () => {
      await rm(rootDir, { force: true, recursive: true });
    },
    rootDir,
  };
}

function tsconfig(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function assertCheckerModuleResolution(options: {
  expectedRawCalls: number;
  expectedResolved: boolean;
  presets: CheckerPreset[];
}): Promise<void> {
  const fixture = await createFixture({
    'src/index.ts': "import './target';\n",
    'src/target.ts': 'export const target = true;\n',
  });

  try {
    const metrics = createProfilingMetricsRecorder();
    const resolved = resolveModuleNameWithCheckersDetailed({
      compilerOptions: {
        moduleResolution: ts.ModuleResolutionKind.Node10,
      },
      containingFile: path.join(fixture.rootDir, 'src/index.ts'),
      context: {
        checkerPresets: options.presets,
        extensions: ['.ts'],
      },
      metrics,
      specifier: options.expectedResolved ? './target' : './missing',
    });

    expect(
      metrics
        .snapshot()
        .filter((metric) => metric.name === 'typescript-resolution')
        .reduce((count, metric) => count + metric.count, 0),
    ).toBe(options.expectedRawCalls);

    if (options.expectedResolved) {
      expect(resolved).toEqual({
        isExternalLibraryImport: false,
        resolvedBy: 'typescript',
        resolvedFileName: toPortablePath(
          path.join(fixture.rootDir, 'src/target.ts'),
        ),
      });
    } else {
      expect(resolved).toBeNull();
    }
  } finally {
    await fixture.cleanup();
  }
}

beforeEach(() => {
  clearCheckerProjectConfigCache();
});

afterEach(() => {
  clearCheckerProjectConfigCache();
});

describe('checker project config parsing', () => {
  it('collects Vue root file names through the Vue language core compiler API', async () => {
    const fixture = await createFixture({
      'src/App.vue': '<script setup lang="ts">const value = 1;</script>\n',
      'tsconfig.json': tsconfig({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.vue'],
      }),
    });

    try {
      const parsed = parseCheckerProjectConfigForContext({
        configPath: path.join(fixture.rootDir, 'tsconfig.json'),
        context: {
          checkerPresets: ['vue-tsc'],
          extensions: [],
        },
        projectRootDir: fixture.rootDir,
      });

      expect(parsed.extensions).toContain('.vue');
      expect(
        toPortableRelativePaths(fixture.rootDir, parsed.fileNames),
      ).toEqual(['src/App.vue']);
    } finally {
      await fixture.cleanup();
    }
  });

  it('reuses unchanged parsed tsconfig results and returns defensive copies', async () => {
    const fixture = await createFixture({
      'src/a.ts': 'export const a = 1;\n',
      'src/b.ts': 'export const b = 1;\n',
      'tsconfig.json': tsconfig({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          noEmit: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/a.ts'],
      }),
    });
    const configPath = path.join(fixture.rootDir, 'tsconfig.json');
    const parseOptions = {
      configPath,
      context: {
        checkerPresets: ['tsc' as const],
        extensions: [] as string[],
      },
      projectRootDir: fixture.rootDir,
    };

    try {
      const first = parseCheckerProjectConfigForContext(parseOptions);

      first.fileNames.push(path.join(fixture.rootDir, 'src/mutated.ts'));

      expect(
        toPortableRelativePaths(
          fixture.rootDir,
          parseCheckerProjectConfigForContext(parseOptions).fileNames,
        ),
      ).toEqual(['src/a.ts']);

      await writeText(
        configPath,
        tsconfig({
          compilerOptions: {
            module: 'ESNext',
            moduleResolution: 'bundler',
            noEmit: true,
            target: 'ES2023',
            types: [],
          },
          include: ['src/b.ts'],
        }),
      );

      expect(
        toPortableRelativePaths(
          fixture.rootDir,
          parseCheckerProjectConfigForContext(parseOptions).fileNames,
        ),
      ).toEqual(['src/b.ts']);
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('checker module resolution', () => {
  it('runs one raw TypeScript resolution for multiple valid presets on success', async () => {
    await assertCheckerModuleResolution({
      expectedRawCalls: 1,
      expectedResolved: true,
      presets: ['tsc', 'tsgo'],
    });
  });

  it('runs one raw TypeScript resolution for multiple valid presets on failure', async () => {
    await assertCheckerModuleResolution({
      expectedRawCalls: 1,
      expectedResolved: false,
      presets: ['tsc', 'tsgo'],
    });
  });

  it('keeps mixed valid and invalid preset behavior with one raw call', async () => {
    await assertCheckerModuleResolution({
      expectedRawCalls: 1,
      expectedResolved: true,
      presets: ['unsupported' as CheckerPreset, 'tsgo'],
    });
  });

  it('does not resolve when every preset is invalid', async () => {
    await assertCheckerModuleResolution({
      expectedRawCalls: 0,
      expectedResolved: false,
      presets: ['unsupported' as CheckerPreset],
    });
  });

  it('keeps the default tsc behavior for an empty preset list', async () => {
    await assertCheckerModuleResolution({
      expectedRawCalls: 1,
      expectedResolved: true,
      presets: [],
    });
  });
});
