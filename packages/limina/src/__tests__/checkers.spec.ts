import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearCheckerProjectConfigCache,
  parseCheckerProjectConfigForContext,
} from '../checkers';

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
        parsed.fileNames.map((filePath) =>
          path.relative(fixture.rootDir, filePath),
        ),
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
        parseCheckerProjectConfigForContext(parseOptions).fileNames.map(
          (filePath) => path.relative(fixture.rootDir, filePath),
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
        parseCheckerProjectConfigForContext(parseOptions).fileNames.map(
          (filePath) => path.relative(fixture.rootDir, filePath),
        ),
      ).toEqual(['src/b.ts']);
    } finally {
      await fixture.cleanup();
    }
  });
});
