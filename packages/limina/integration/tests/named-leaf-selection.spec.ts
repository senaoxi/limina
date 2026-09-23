import { copyFile, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  expectLiminaSuccess,
  readJson,
  runFixtureLimina,
} from '../helpers/assertions';
import { prepareFixture } from '../helpers/fixture';

describe('named leaf configuration through public CLI', () => {
  it.each(['nested default solutions', 'direct terminal references'])(
    'includes named leaves through %s',
    async (mode) => {
      const fixture = await prepareFixture('project-references');
      try {
        if (mode === 'direct terminal references') {
          await writeFile(
            fixture.path('repo/tsconfig.json'),
            JSON.stringify({
              files: [],
              references: [
                { path: './packages/app/tsconfig.lib.json' },
                { path: './packages/app/tsconfig.test.json' },
              ],
            }),
          );
        }
        expectLiminaSuccess(
          await runFixtureLimina(fixture, ['graph', 'prepare']),
        );
        const manifest = await readJson<{
          checkers: { tsc: { roots: string[] } };
        }>(fixture.path('repo/.limina/manifest.json'));
        expect(manifest.checkers.tsc.roots).toEqual([
          'packages/app/tsconfig.lib.json',
          'packages/app/tsconfig.test.json',
        ]);
        expectLiminaSuccess(
          await runFixtureLimina(fixture, ['graph', 'check']),
        );
      } finally {
        await fixture.cleanup();
      }
    },
  );
  it('rejects named leaves selected directly by checker.include', async () => {
    const fixture = await prepareFixture('project-references');
    try {
      await writeFile(
        fixture.configPath,
        "export default {config:{checkers:{tsc:{include:['packages/app/tsconfig.lib.json']}}}};\n",
      );
      const result = await runFixtureLimina(fixture, ['graph', 'prepare']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        'Checker include matched non-entry tsconfig files',
      );
      expect(result.stderr).toContain(
        'checker.include may only match tsconfig.json entry files',
      );
    } finally {
      await fixture.cleanup();
    }
  });
  it('rejects a named config used as an intermediate solution', async () => {
    const fixture = await prepareFixture('project-references');
    try {
      await copyFile(
        fixture.path('repo/packages/app/tsconfig.json'),
        fixture.path('repo/packages/app/tsconfig.named.json'),
      );
      await writeFile(
        fixture.path('repo/tsconfig.json'),
        JSON.stringify({
          files: [],
          references: [{ path: './packages/app/tsconfig.named.json' }],
        }),
      );
      const result = await runFixtureLimina(fixture, ['graph', 'prepare']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        'Source typecheck config declares project references',
      );
      expect(result.stderr).toContain('packages/app/tsconfig.named.json');
    } finally {
      await fixture.cleanup();
    }
  });
});
