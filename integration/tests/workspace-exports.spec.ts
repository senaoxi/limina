import { mkdir, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { expectLiminaSuccess, runFixtureLimina } from '../helpers/assertions';
import { prepareFixture } from '../helpers/fixture';

describe('workspace exports consumption', () => {
  it.each([
    { name: 'no exports', exports: undefined, passes: true, runtime: false },
    {
      imported: false,
      name: 'source type entry',
      exports: { '.': { types: './src/index.ts' } },
      passes: true,
      runtime: false,
    },
    {
      imported: false,
      name: 'missing types',
      exports: { '.': { types: './dist/missing.d.ts' } },
      passes: true,
      runtime: false,
    },
    {
      imported: false,
      name: 'missing runtime',
      exports: { './runtime': './dist/runtime.js' },
      passes: true,
      runtime: false,
    },
    {
      imported: false,
      name: 'unimported existing JavaScript',
      exports: { './runtime': './dist/runtime.js' },
      passes: true,
      runtime: true,
    },
    {
      name: 'imported JavaScript without types',
      exports: { './runtime': './dist/runtime.js' },
      passes: false,
      runtime: true,
      imported: true,
    },
  ])('checks $name', async (entry) => {
    const fixture = await prepareFixture('workspace-exports');
    try {
      await writeFile(
        fixture.path('repo/packages/demo/package.json'),
        JSON.stringify({
          name: 'demo',
          private: true,
          type: 'module',
          exports: entry.exports,
        }),
      );
      if (entry.runtime) {
        await mkdir(fixture.path('repo/packages/demo/dist'));
        await writeFile(
          fixture.path('repo/packages/demo/dist/runtime.js'),
          'export const runtime = 1;\n',
        );
      }
      if (entry.imported) {
        await writeFile(
          fixture.path('repo/packages/demo/src/index.ts'),
          "import { runtime } from 'demo/runtime'; export const value = runtime;\n",
        );
      }
      const result = await runFixtureLimina(fixture, ['graph', 'check']);
      if (entry.passes) {
        expectLiminaSuccess(result);
      } else {
        expect(result.timedOut).toBe(false);
        expect(result.code, result.stdout + result.stderr).toBe(1);
        const invocation = /Standalone issue invocation: ([a-f0-9-]+)/u.exec(
          result.stdout,
        )?.[1];
        expect(invocation).toBeDefined();
        const query = await runFixtureLimina(fixture, [
          'check',
          '--issues',
          '--invocation',
          invocation!,
          '--format',
          'json',
        ]);
        expectLiminaSuccess(query);
        expect(query.stdout).toContain('stable type or checker source entry');
        expect(query.stdout).toContain('demo');
      }
    } finally {
      await fixture.cleanup();
    }
  });
});
