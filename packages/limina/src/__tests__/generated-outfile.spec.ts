import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { prepareAndMaterializeGeneratedTsconfigGraph } from './helpers/generated-graph';
import { withFixtureGovernanceRoot } from './helpers/governance-root';
import { createSemanticRepairFixture } from './helpers/semantic-repair';

describe('generated graph outFile admission', () => {
  it.each(['astro', 'svelte-check'] as const)(
    'retains outFile for non-emitting %s checks',
    async (checker) => {
      const source = JSON.stringify({
        compilerOptions: {
          module: 'AMD',
          moduleResolution: 'Node10',
          ignoreDeprecations: '6.0',
          noEmit: true,
          outFile: './bundle.js',
          types: [],
          lib: ['es5'],
        },
        files: ['index.ts'],
      });
      const f = await createSemanticRepairFixture({
        'package.json': JSON.stringify({ name: 'framework-outfile-fixture' }),
        'a/tsconfig.json': source,
        'a/index.ts': 'export const value = 1;',
      });
      try {
        const config = withFixtureGovernanceRoot({
          rootDir: f.root,
          configPath: f.path('limina.config.mjs'),
          scope: { checkers: { [checker]: { include: ['a/tsconfig.json'] } } },
        });
        const graph = await prepareAndMaterializeGeneratedTsconfigGraph(config);
        expect(
          graph.governedSources.get(checker)?.has(f.path('a/tsconfig.json')),
        ).toBe(true);
        expect(graph.sourceToDts.get(checker)?.size ?? 0).toBe(0);
        expect(readFileSync(f.path('a/tsconfig.json'), 'utf8')).toBe(source);
        expect(existsSync(f.path('a/bundle.js'))).toBe(false);
      } finally {
        await f.cleanup();
      }
    },
  );

  it.each([
    { inherited: false, outputs: false },
    { inherited: true, outputs: false },
    { inherited: true, outputs: true },
  ])(
    'rejects effective outFile before materialization: inherited=$inherited, outputs=$outputs',
    async ({ inherited, outputs }) => {
      const source = JSON.stringify({
        ...(inherited && { extends: '../base.json' }),
        compilerOptions: {
          composite: true,
          module: 'System',
          types: [],
          lib: ['es5'],
          ...(!inherited && { outFile: './bundle.js' }),
        },
        files: ['index.ts'],
        ...(outputs && {
          liminaOptions: { outputs: { rootDir: '.', outDir: '../dist' } },
        }),
      });
      const f = await createSemanticRepairFixture({
        'package.json': JSON.stringify({
          name: 'outfile-fixture',
          private: true,
        }),
        'base.json': JSON.stringify({
          compilerOptions: { outFile: './bundle.js' },
        }),
        'a/tsconfig.json': source,
        'a/index.ts': 'export const value = 1;',
      });
      try {
        const config = withFixtureGovernanceRoot({
          rootDir: f.root,
          configPath: f.path('limina.config.mjs'),
          scope: { checkers: { tsc: { include: ['a/tsconfig.json'] } } },
        });
        await expect(
          prepareAndMaterializeGeneratedTsconfigGraph(config),
        ).rejects.toThrow('outFile is not supported in generated projects');
        expect(existsSync(f.path('.limina/tsconfig'))).toBe(false);
        expect(readFileSync(f.path('a/tsconfig.json'), 'utf8')).toBe(source);
      } finally {
        await f.cleanup();
      }
    },
  );
});
