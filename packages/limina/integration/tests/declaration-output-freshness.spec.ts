import {
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createSemanticRepairFixture } from '../../src/__tests__/helpers/semantic-repair';
import { readCheckIssueSnapshot } from '../../src/check-reporting/snapshot';
import { runLimina } from '../helpers/run-limina';

const require = createRequire(import.meta.url);

it.each(['warm', 'outputs', 'analysis'] as const)(
  'publishes a complete check after cold declaration emission and %s recovery',
  async (recovery) => {
    const options = {
      target: 'ES2020',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      types: [],
      strict: true,
      noEmit: true,
    };
    const f = await createSemanticRepairFixture({
      'package.json':
        '{"name":"fixture","private":true,"type":"module","packageManager":"npm@11.6.1"}',
      'package-lock.json': '{"lockfileVersion":3,"packages":{"":{}}}',
      'limina.config.mjs':
        'export default {scope:{checkers:{"vue-tsc":{include:["tsconfig.json"]}}},source:{knip:false}};',
      'tsconfig.json': JSON.stringify({
        files: [],
        references: [
          { path: './tsconfig.lib.json' },
          { path: './tsconfig.app.json' },
        ],
      }),
      'tsconfig.lib.json': JSON.stringify({
        compilerOptions: options,
        include: ['lib/**/*.ts'],
      }),
      'tsconfig.app.json': JSON.stringify({
        compilerOptions: options,
        include: ['app/**/*.ts'],
      }),
      'lib/top.ts': 'export const top: number = 1;',
      'lib/nested/value.ts': 'export const value: number = 2;',
      'app/index.ts':
        'import { value } from "../lib/nested/value.js"; export const result: number = value;',
    });
    try {
      for (const name of ['typescript', 'vue-tsc', 'vue']) {
        const target = f.path('node_modules', name);
        await mkdir(path.dirname(target), { recursive: true });
        const installed = path.dirname(require.resolve(`${name}/package.json`));
        await symlink(await realpath(installed), target, 'junction');
      }
      const check = async () => {
        const result = await runLimina({
          fixtureName: 'declaration-output-freshness',
          cwd: f.root,
          args: ['check'],
          env: { LIMINA_PROFILE: '1' },
        });
        expect(result.code, result.stdout + result.stderr).toBe(0);
        const snapshot = await readCheckIssueSnapshot(f.path());
        expect(snapshot).not.toBeNull();
        expect(snapshot?.issues).toEqual([]);
        const entries = await readdir(f.path('.limina'), { recursive: true });
        const profilePath = entries.find((entry) =>
          entry.endsWith('last-profile.json'),
        );
        expect(profilePath).toBeDefined();
        const profile = JSON.parse(
          await readFile(f.path('.limina', profilePath!), 'utf8'),
        ) as { metrics: { name: string; kind?: string; count?: number }[] };
        return (
          profile.metrics.find(
            (event) =>
              event.name === 'analysis-cache' && event.kind === 'graphHits',
          )?.count ?? 0
        );
      };
      expect(await check()).toBe(0);
      if (recovery === 'outputs') {
        await rm(f.path('.limina/dts'), { recursive: true });
        await rm(f.path('.limina/tsbuildinfo'), { recursive: true });
      } else if (recovery === 'analysis')
        await rm(f.path('.limina/cache'), { recursive: true });
      const hits = await check();
      if (recovery === 'warm') expect(hits).toBeGreaterThan(0);
      else if (recovery === 'analysis') expect(hits).toBe(0);
      expect(
        await readFile(
          f.path(
            '.limina/dts/checkers/vue-tsc/tsconfig.lib.json/nested/value.d.ts',
          ),
          'utf8',
        ),
      ).toContain('value: number');
    } finally {
      await f.cleanup();
    }
  },
  60_000,
);
