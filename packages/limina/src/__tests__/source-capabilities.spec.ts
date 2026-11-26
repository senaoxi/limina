import { describe, expect, it } from 'vitest';
import { inspectFrameworkIntent } from '../core/build-graph/framework-intent';
import { partitionSourceFiles } from '../core/build-graph/source-capabilities';
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
  });

  it('uses direct framework declarations without resolving presets or selectors', () => {
    const configPath = '/workspace/tsconfig.json';
    const result = inspectFrameworkIntent({
      configPath,
      configObject: {
        extends: [
          'astro/tsconfigs/strict.json',
          '.\\.svelte-kit\\tsconfig.json',
        ],
        compilerOptions: {
          plugins: [{ name: '@astrojs/ts-plugin' }],
          types: ['astro/client'],
        },
        files: ['unwritten.astro'],
        include: ['src/**/*.svelte', 'src/**/*.vue'],
        vueCompilerOptions: {},
      },
    });

    expect(result.map(({ kind }) => kind)).toEqual([
      'astro-plugin',
      'astro-preset',
      'astro-selector',
      'astro-types',
      'svelte-kit-extends',
      'svelte-selector',
      'vue-compiler-options',
      'vue-selector',
    ]);
    expect(result.every((hint) => hint.configPath === configPath)).toBe(true);
  });

  it('ignores unrelated extends, excludes, and non-object Vue options', () => {
    expect(
      inspectFrameworkIntent({
        configPath: '/workspace/tsconfig.json',
        configObject: {
          extends: ['./base.json', './.astro/tsconfigs/strict.json'],
          exclude: ['src/**/*.vue'],
          vueCompilerOptions: null,
        },
      }),
    ).toEqual([]);
  });
});
