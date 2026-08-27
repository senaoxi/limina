import type { ResolvedLiminaConfig } from '#config/runner';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { inspectFrameworkIntent } from '../core/build-graph/framework-intent';
import {
  collectConfirmedFrameworkCapabilities,
  partitionSourceFiles,
} from '../core/build-graph/source-capabilities';

async function createFixture(files: Record<string, unknown>): Promise<{
  cleanup: () => Promise<void>;
  config: ResolvedLiminaConfig;
  rootDir: string;
}> {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-capabilities-'));
  for (const [relativePath, value] of Object.entries(files)) {
    const filePath = path.join(rootDir, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
  }
  return {
    cleanup: () => rm(rootDir, { force: true, recursive: true }),
    config: {
      config: {},
      configPath: path.join(rootDir, 'limina.config.mjs'),
      rootDir,
    },
    rootDir,
  };
}

describe('source capability facts', () => {
  it('partitions checker-resolved effective files by source family', () => {
    const partition = partitionSourceFiles([
      '/workspace/src/App.vue',
      '/workspace/src/component.svelte',
      '/workspace/src/index.ts',
      '/workspace/src/page.astro',
    ]);

    expect(partition).toEqual({
      astroFiles: ['/workspace/src/page.astro'],
      svelteFiles: ['/workspace/src/component.svelte'],
      typescriptFiles: ['/workspace/src/index.ts'],
      vueFiles: ['/workspace/src/App.vue'],
    });
    expect(collectConfirmedFrameworkCapabilities(partition)).toEqual([
      'astro',
      'svelte',
      'vue',
    ]);
  });

  it('collects inherited intent hints without confirming capabilities', async () => {
    const fixture = await createFixture({
      'base.json': {
        compilerOptions: {
          plugins: [{ name: '@astrojs/ts-plugin' }],
          types: ['astro/client'],
        },
        vueCompilerOptions: {},
      },
      'tsconfig.json': {
        extends: './base.json',
        include: ['src/**/*.ts'],
      },
    });

    try {
      const result = inspectFrameworkIntent({
        config: fixture.config,
        configObject: {
          extends: './base.json',
          include: ['src/**/*.ts'],
        },
        configPath: path.join(fixture.rootDir, 'tsconfig.json'),
      });

      expect(result.problems).toEqual([]);
      expect(result.intentHints.map((hint) => hint.kind)).toEqual([
        'astro-plugin',
        'astro-types',
        'vue-compiler-options',
      ]);
      expect(
        collectConfirmedFrameworkCapabilities(partitionSourceFiles([])),
      ).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('reports an unavailable generated extends before checker parsing', async () => {
    const fixture = await createFixture({
      'tsconfig.json': {
        extends: './.astro/tsconfigs/strict.json',
      },
    });

    try {
      const result = inspectFrameworkIntent({
        config: fixture.config,
        configObject: {
          extends: './.astro/tsconfigs/strict.json',
        },
        configPath: path.join(fixture.rootDir, 'tsconfig.json'),
      });

      expect(result.problems).toHaveLength(1);
      expect(result.problems[0]).toContain(
        'Unavailable auto checker extends config',
      );
      expect(result.problems[0]).toContain('.astro/tsconfigs/strict.json');
    } finally {
      await fixture.cleanup();
    }
  });
});
