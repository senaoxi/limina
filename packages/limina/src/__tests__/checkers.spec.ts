import {
  CheckerProjectConfigCache,
  parseCheckerProjectConfigForContext,
  resolveModuleNameWithCheckersDetailed,
} from '#checkers';
import type { CheckerPreset } from '#config/runner';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { createProfilingMetricsRecorder } from '../profiling/metrics';
import {
  createFixturePathResolver,
  toPortablePath,
  toPortableRelativePaths,
} from './helpers/path';

async function writeText(filePath: string, text: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text);
}

async function createFixture(files: Record<string, string>): Promise<{
  cleanup: () => Promise<void>;
  path: (...segments: string[]) => string;
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
    path: createFixturePathResolver(rootDir),
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
    const configPath = fixture.path('tsconfig.json');
    const cache = new CheckerProjectConfigCache();
    const parseOptions = {
      cache,
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

  it('keeps glob and extends snapshots within one cache generation and refreshes them with a new cache', async () => {
    const fixture = await createFixture({
      'src/a.ts': 'export const a = 1;\n',
      'src/b.ts': 'export const b = 1;\n',
      'tsconfig.base.json': tsconfig({ include: ['src/a.ts'] }),
      'tsconfig.json': tsconfig({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          noEmit: true,
          target: 'ES2023',
          types: [],
        },
        extends: './tsconfig.base.json',
      }),
    });
    const configPath = path.join(fixture.rootDir, 'tsconfig.json');
    const parseWith = (cache?: CheckerProjectConfigCache) =>
      toPortableRelativePaths(
        fixture.rootDir,
        parseCheckerProjectConfigForContext({
          cache,
          configPath,
          context: {
            checkerPresets: ['tsc'],
            extensions: [],
          },
          projectRootDir: fixture.rootDir,
        }).fileNames,
      );

    try {
      const generationZero = new CheckerProjectConfigCache();
      expect(parseWith(generationZero)).toEqual(['src/a.ts']);
      await writeText(
        path.join(fixture.rootDir, 'tsconfig.base.json'),
        tsconfig({ include: ['src/*.ts'] }),
      );

      expect(parseWith(generationZero)).toEqual(['src/a.ts']);
      const generationOne = new CheckerProjectConfigCache();
      expect(parseWith(generationOne)).toEqual(['src/a.ts', 'src/b.ts']);

      await rm(path.join(fixture.rootDir, 'src/a.ts'));
      expect(parseWith(generationOne)).toEqual(['src/a.ts', 'src/b.ts']);
      expect(parseWith(new CheckerProjectConfigCache())).toEqual(['src/b.ts']);
      expect(parseWith()).toEqual(['src/b.ts']);
    } finally {
      await fixture.cleanup();
    }
  });

  it('keeps virtual-file cache identity independent of localeCompare', async () => {
    const fixture = await createFixture({
      'src/a.ts': 'export const a = true;\n',
      'src/z.ts': 'export const z = true;\n',
      'src/ä.ts': 'export const umlaut = true;\n',
      'tsconfig.json': tsconfig({ include: ['src/*.ts'] }),
    });
    const configPath = fixture.path('tsconfig.json');
    const virtualFiles = new Map([
      [fixture.path('z.ts'), 'export const z = true;\n'],
      [fixture.path('ä.ts'), 'export const umlaut = true;\n'],
      [fixture.path('a.ts'), 'export const a = true;\n'],
      [configPath, tsconfig({ include: ['src/*.ts'] })],
    ]);
    const localeCompare = vi
      .spyOn(String.prototype, 'localeCompare')
      .mockImplementation(() => {
        throw new Error('checker cache identity used localeCompare');
      });

    try {
      const parsed = parseCheckerProjectConfigForContext({
        cache: new CheckerProjectConfigCache(),
        configPath,
        context: {
          checkerPresets: ['tsc'],
          extensions: [],
        },
        projectRootDir: fixture.rootDir,
        virtualFiles,
      });

      expect(
        toPortableRelativePaths(fixture.rootDir, parsed.fileNames),
      ).toEqual(['src/a.ts', 'src/z.ts', 'src/ä.ts']);
    } finally {
      localeCompare.mockRestore();
      await fixture.cleanup();
    }
  });

  it('isolates physical, virtual, and independent generation caches', async () => {
    const fixture = await createFixture({
      'src/physical.ts': 'export const physical = true;\n',
      'src/virtual.ts': 'export const virtual = true;\n',
      'tsconfig.json': tsconfig({ include: ['src/physical.ts'] }),
    });
    const configPath = fixture.path('tsconfig.json');
    const cache = new CheckerProjectConfigCache();
    const parse = (virtualFiles?: ReadonlyMap<string, string>) =>
      toPortableRelativePaths(
        fixture.rootDir,
        parseCheckerProjectConfigForContext({
          cache,
          configPath,
          context: {
            checkerPresets: ['tsc'],
            extensions: [],
          },
          projectRootDir: fixture.rootDir,
          virtualFiles,
        }).fileNames,
      );

    try {
      expect(parse()).toEqual(['src/physical.ts']);
      expect(
        parse(
          new Map([[configPath, tsconfig({ include: ['src/virtual.ts'] })]]),
        ),
      ).toEqual(['src/virtual.ts']);

      cache.set('manager-a-only', {
        extensions: [],
        fileNames: [],
        options: {},
      });
      expect(new CheckerProjectConfigCache().get('manager-a-only')).toBe(
        undefined,
      );
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('checker module resolution', () => {
  it('accepts only declared checker-source extensions across relative, paths, and package exports', async () => {
    const fixture = await createFixture({
      'node_modules/@example/theme/Theme.vue': '<template><div /></template>\n',
      'node_modules/@example/theme/package.json': tsconfig({
        exports: {
          './theme': './Theme.vue',
        },
        name: '@example/theme',
      }),
      'src/App.vue': '<template><div /></template>\n',
      'src/data.yaml': 'value: true\n',
      'src/icon.svg': '<svg />\n',
      'src/index.ts': 'export const value = true;\n',
      'src/readme.txt': 'text\n',
      'src/style.css': '.root {}\n',
    });
    const compilerOptions = {
      baseUrl: fixture.rootDir,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      paths: {
        '@app/*': ['src/*'],
      },
    } satisfies ts.CompilerOptions;
    const context = {
      checkerPresets: ['vue-tsc' as const],
      extensions: ['.ts', '.tsx', '.mts', '.cts', '.vue'],
    };
    const containingFile = path.join(fixture.rootDir, 'src/index.ts');

    try {
      for (const [specifier, expectedRelativePath] of [
        ['./App.vue', 'src/App.vue'],
        ['@app/App', 'src/App.vue'],
        ['@example/theme/theme', 'node_modules/@example/theme/Theme.vue'],
      ] as const) {
        expect(
          resolveModuleNameWithCheckersDetailed({
            compilerOptions,
            containingFile,
            context,
            specifier,
          }),
        ).toEqual({
          isExternalLibraryImport: false,
          resolvedBy: 'checker-source',
          resolvedFileName: toPortablePath(
            path.join(fixture.rootDir, expectedRelativePath),
          ),
        });
      }

      for (const specifier of [
        './style.css',
        './icon.svg',
        './data.yaml',
        './readme.txt',
      ]) {
        expect(
          resolveModuleNameWithCheckersDetailed({
            compilerOptions,
            containingFile,
            context,
            specifier,
          }),
        ).toBeNull();
      }
    } finally {
      await fixture.cleanup();
    }
  });

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
