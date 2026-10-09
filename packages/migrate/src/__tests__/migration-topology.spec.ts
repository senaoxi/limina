import { parse } from 'jsonc-parser';
import { loadConfig } from 'limina/internal/config/runner';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { runMigration } from '../migration';
import type { RunMigrationOptions } from '../migration/types';
import { createFixturePathResolver } from './helpers/path';

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const source = (options: Record<string, unknown> = {}): string =>
  json({ compilerOptions: options, files: ['./src/index.ts'] });
const solution = (...references: string[]): string =>
  json({
    files: [],
    references: references.map((reference) => ({ path: reference })),
  });

async function fixture(
  extra: Record<string, string>,
  configFile = 'limina.config.mjs',
) {
  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), 'limina-adoption-'),
  );
  const rootDirectory = await realpath(temporaryDirectory);
  const locate = createFixturePathResolver(rootDirectory);
  const files = {
    'package.json': json({ name: 'root', private: true, type: 'module' }),
    'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
    'limina.config.mjs': 'export default {};\n',
    'packages/app/package.json': json({ name: '@fixture/app', private: true }),
    'packages/app/good/tsconfig.json': source({ noEmit: true }),
    'packages/app/good/src/index.ts': 'export const good = 1;\n',
    ...extra,
  };
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(locate(file)), { recursive: true });
    await writeFile(locate(file), content);
  }
  const git = promisify(execFile);
  await git('git', ['init'], { cwd: rootDirectory });
  await git('git', ['add', '.'], { cwd: rootDirectory });
  await git(
    'git',
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '--no-gpg-sign',
      '-m',
      'fixture',
    ],
    { cwd: rootDirectory },
  );
  return {
    path: locate,
    rerunFresh: async () => {
      await git('git', ['add', '.'], { cwd: rootDirectory });
      await git(
        'git',
        [
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.test',
          'commit',
          '--no-gpg-sign',
          '-m',
          'after adoption',
        ],
        { cwd: rootDirectory },
      );
      const cli = path.resolve(
        import.meta.dirname,
        '../../bin/limina-migrate.js',
      );
      await git(process.execPath, [cli], { cwd: rootDirectory });
      return JSON.parse(
        await readFile(locate('.limina/migration/latest.json'), 'utf8'),
      );
    },
    run: async (options: RunMigrationOptions = {}) =>
      runMigration(
        await loadConfig({
          configPath: locate(configFile),
          configLoader: options.configLoader,
          command: 'migration',
        }),
        { confirmDirtyWorkspace: async () => true, ...options },
      ),
    read: async (file: string) =>
      parse(await readFile(locate(file), 'utf8')) as Record<string, any>,
    report: async () =>
      JSON.parse(
        await readFile(locate('.limina/migration/latest.json'), 'utf8'),
      ) as {
        records: {
          kind: string;
          configPath: string;
          message: string;
          details?: any;
        }[];
        verification: {
          topologies: {
            command: string;
            sources: string[];
            reachableSources: Record<string, string[]>;
          }[];
        };
      },
    cleanup: () => rm(rootDirectory, { recursive: true, force: true }),
  };
}

describe('migration input topology', () => {
  it.each(['native', 'tsx'] as const)(
    'verifies CommonJS configuration in separate check and graph processes with %s',
    async (configLoader) => {
      const f = await fixture(
        {
          'limina.config.cjs': `module.exports=(environment)=>{
require('node:fs').appendFileSync(require('node:path').join(__dirname,'evaluations.jsonl'),JSON.stringify({command:environment.command,pid:process.pid})+'\\n');
return {};};`,
        },
        'limina.config.cjs',
      );
      try {
        const result = await f.run({ configLoader });
        expect(result.inputConsumable).toBe(true);
        const report = await f.report();
        expect(
          report.verification.topologies.map((value) => value.command),
        ).toEqual(['check', 'graph']);
        const evaluations = (
          await readFile(f.path('evaluations.jsonl'), 'utf8')
        )
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as { command: string; pid: number });
        const verification = evaluations.filter((value) =>
          ['check', 'graph'].includes(value.command),
        );
        expect(
          verification
            .map((value) => value.command)
            .sort((left, right) => Number(left > right) - Number(left < right)),
        ).toEqual(['check', 'graph']);
        expect(new Set(verification.map((value) => value.pid)).size).toBe(2);
      } finally {
        await f.cleanup();
      }
    },
  );
  it('isolates empty default and named inputs while preserving healthy membership and fresh consumption', async () => {
    const f = await fixture({
      'packages/app/tsconfig.json': solution(
        './good',
        './empty',
        './named/tsconfig.lib.json',
      ),
      'packages/app/empty/tsconfig.json': '',
      'packages/app/named/tsconfig.lib.json': '',
    });
    try {
      const result = await f.run();
      expect(result.inputConsumable).toBe(true);
      expect(result.isolatedFiles).toEqual([
        f.path('packages/app/empty/tsconfig.json'),
        f.path('packages/app/named/tsconfig.lib.json'),
      ]);
      expect((await f.read('packages/app/tsconfig.json')).references).toEqual([
        { path: './good' },
      ]);
      for (const file of ['empty/tsconfig.json', 'named/tsconfig.lib.json'])
        expect(await readFile(f.path(`packages/app/${file}`), 'utf8')).toBe('');
      const report = await f.report();
      for (const topology of report.verification.topologies)
        expect(topology.sources).toEqual([
          f.path('packages/app/good/tsconfig.json'),
        ]);
      expect((await f.rerunFresh()).result.modifiedFiles).toEqual([]);
    } finally {
      await f.cleanup();
    }
  });

  it('reports unresolved observations separately from fresh input consumption', async () => {
    const f = await fixture({
      'packages/app/good/src/index.ts':
        "import type { Missing } from 'not-installed'; export type Result = Missing;",
    });
    try {
      const result = await f.run();
      expect(result.inputConsumable).toBe(true);
      expect(result.comparisonComplete).toBe(false);
      expect(result.analysisDiagnostics.join('\n')).toContain('not-installed');
      expect(result.analysisDiagnostics.join('\n')).toContain(
        'good/src/index.ts:1',
      );
      expect(result.analysisDiagnostics.join('\n')).toContain(
        'declaration-reference-inference',
      );
    } finally {
      await f.cleanup();
    }
  });

  it('rejects manifest drift after confirmation and publishes the failed attempt without writing configs', async () => {
    const f = await fixture({ 'README.md': 'original' });
    try {
      const before = await readFile(
        f.path('packages/app/good/tsconfig.json'),
        'utf8',
      );
      await writeFile(f.path('README.md'), 'dirty');
      await expect(
        f.run({
          confirmDirtyWorkspace: async () => {
            await writeFile(
              f.path('packages/app/package.json'),
              json({ name: '@fixture/changed', private: true }),
            );
            return true;
          },
        }),
      ).rejects.toThrow('Migration planning input changed before writing');
      expect(
        await readFile(f.path('packages/app/good/tsconfig.json'), 'utf8'),
      ).toBe(before);
      const report = await f.report();
      expect(
        report.records.find((record) => record.kind === 'migration-failed')
          ?.message,
      ).toContain('package.json');
      expect(report.verification.topologies).toEqual([]);
    } finally {
      await f.cleanup();
    }
  });

  it('retains missing-file sources and native declarations while migrating healthy siblings', async () => {
    const f = await fixture({
      'packages/app/missing/tsconfig.json': json({
        files: ['generated.ts'],
        references: [{ path: '../good' }],
      }),
    });
    try {
      const result = await f.run();
      expect(result.inputConsumable).toBe(true);
      const migrated = await f.read('packages/app/missing/tsconfig.json');
      expect(migrated.references).toBeUndefined();
      expect(migrated.files).toEqual(['generated.ts']);
      expect(migrated.liminaOptions.implicitRefs).toEqual([
        expect.objectContaining({ path: '../good/tsconfig.json' }),
      ]);
      expect(
        (await f.read('packages/app/good/tsconfig.json')).$schema,
      ).toBeDefined();
      const report = await f.report();
      expect(
        report.records.filter((record) => record.kind === 'isolated'),
      ).toEqual([]);
      const analysis = report.records.find(
        (record) => record.kind === 'dependency-analysis',
      )!.details;
      expect(analysis.complete).toBe(false);
      expect(analysis.diagnostics.join('\n')).toContain('generated.ts');
      expect((await f.run()).modifiedFiles).toEqual([]);
    } finally {
      await f.cleanup();
    }
  });

  it('expands source declarations through default and named solutions without requiring checker mapping', async () => {
    const f = await fixture({
      'packages/app/client/tsconfig.json': json({
        files: ['index.ts'],
        references: [
          { path: '../wrapper' },
          { path: '../standalone/tsconfig.lib.json' },
        ],
      }),
      'packages/app/client/index.ts': 'export {};',
      'packages/app/wrapper/tsconfig.json': solution('./tsconfig.group.json'),
      'packages/app/wrapper/tsconfig.group.json': solution(
        './tsconfig.lib.json',
      ),
      'packages/app/wrapper/tsconfig.lib.json': json({ files: ['index.ts'] }),
      'packages/app/wrapper/index.ts': 'export {};',
      'packages/app/standalone/tsconfig.lib.json': json({
        files: ['generated.ts'],
      }),
    });
    try {
      const result = await f.run();
      const client = await f.read('packages/app/client/tsconfig.json');
      expect(client.liminaOptions.implicitRefs).toEqual([
        expect.objectContaining({ path: '../wrapper/tsconfig.lib.json' }),
        expect.objectContaining({ path: '../standalone/tsconfig.lib.json' }),
      ]);
      expect(
        (await f.read('packages/app/standalone/tsconfig.lib.json')).$schema,
      ).toBeDefined();
      expect(result.inputConsumable).toBe(true);
      const report = await f.report();
      expect(
        report.records.find(
          (record) => record.kind === 'native-solution-expanded',
        )?.details.members,
      ).toEqual([f.path('packages/app/wrapper/tsconfig.lib.json')]);
      expect((await f.run()).modifiedFiles).toEqual([]);
    } finally {
      await f.cleanup();
    }
  });

  it('rejects self-hiding output while adopting the source and accepting an independent safe output', async () => {
    const f = await fixture({
      'packages/app/tools/tsconfig.json': source({
        rootDir: './src',
        outDir: '.',
      }),
      'packages/app/tools/src/index.ts': 'export const tool = 1;',
      'packages/app/safe/tsconfig.json': source({
        rootDir: './src',
        outDir: './dist',
      }),
      'packages/app/safe/src/index.ts': 'export const safe = 1;',
    });
    try {
      expect((await f.run()).inputConsumable).toBe(true);
      expect(
        (await f.read('packages/app/tools/tsconfig.json')).liminaOptions,
      ).toBeUndefined();
      expect(
        (await f.read('packages/app/safe/tsconfig.json')).liminaOptions.outputs,
      ).toEqual({ outDir: './dist', rootDir: './src' });
      const report = await f.report();
      expect(
        report.records.filter((entry) => entry.kind === 'isolated'),
      ).toEqual([]);
      expect(
        report.records.filter((entry) => entry.kind === 'output-rejected'),
      ).toHaveLength(1);
      expect(
        report.records.find((entry) => entry.kind === 'output-rejected')
          ?.details.restoredCheck,
      ).toEqual({ complete: true, diagnostics: [], missing: [] });
      for (const topology of report.verification.topologies)
        expect(topology.sources).toEqual([
          f.path('packages/app/good/tsconfig.json'),
          f.path('packages/app/safe/tsconfig.json'),
          f.path('packages/app/tools/tsconfig.json'),
        ]);
      const before = await readFile(f.path('packages/app/tools/tsconfig.json'));
      expect((await f.run()).modifiedFiles).toEqual([]);
      expect(
        await readFile(f.path('packages/app/tools/tsconfig.json')),
      ).toEqual(before);
    } finally {
      await f.cleanup();
    }
  });

  it('rejects a stable output which hides default and solution-owned named sources', async () => {
    const f = await fixture({
      'packages/app/producer/tsconfig.json': source({ outDir: '../generated' }),
      'packages/app/producer/src/index.ts': 'export const producer = 1;',
      'packages/app/generated/tsconfig.json': solution('./tsconfig.lib.json'),
      'packages/app/generated/tsconfig.lib.json': source(),
      'packages/app/generated/src/index.ts': 'export const generated = 1;',
    });
    try {
      expect((await f.run()).inputConsumable).toBe(true);
      expect(
        (await f.read('packages/app/producer/tsconfig.json')).liminaOptions,
      ).toBeUndefined();
      const { topologies } = (await f.report()).verification;
      for (const topology of topologies)
        expect(
          topology.reachableSources[
            f.path('packages/app/generated/tsconfig.json')
          ],
        ).toEqual([f.path('packages/app/generated/tsconfig.lib.json')]);
    } finally {
      await f.cleanup();
    }
  });

  it('rejects mutually hiding proposals once in stable path order without isolating either source', async () => {
    const f = await fixture({
      'packages/app/b/tsconfig.json': source({ outDir: '../a' }),
      'packages/app/b/src/index.ts': 'export const b = 1;',
      'packages/app/a/tsconfig.json': source({ outDir: '../b' }),
      'packages/app/a/src/index.ts': 'export const a = 1;',
    });
    try {
      expect((await f.run()).inputConsumable).toBe(true);
      const report = await f.report();
      expect(
        report.records
          .filter((record) => record.kind === 'output-rejected')
          .map((record) => record.configPath),
      ).toEqual([
        f.path('packages/app/a/tsconfig.json'),
        f.path('packages/app/b/tsconfig.json'),
      ]);
      expect(
        report.records.filter((record) => record.kind === 'isolated'),
      ).toEqual([]);
      for (const name of ['a', 'b'])
        expect(
          (await f.read(`packages/app/${name}/tsconfig.json`)).liminaOptions,
        ).toBeUndefined();
      expect((await f.run()).modifiedFiles).toEqual([]);
    } finally {
      await f.cleanup();
    }
  });

  it.each([
    {
      name: 'direct noEmit',
      own: { noEmit: true, outDir: './dist' },
      base: {},
    },
    {
      name: 'inherited noEmit',
      own: { outDir: './dist' },
      base: { noEmit: true },
    },
    { name: 'rootDir only', own: { rootDir: './src' }, base: {} },
    {
      name: 'declaration only',
      own: { emitDeclarationOnly: true, declaration: true, outDir: './dist' },
      base: {},
    },
    {
      name: 'split directories',
      own: { outDir: './dist', declarationDir: './types' },
      base: {},
    },
    {
      name: 'outFile',
      own: { outFile: './bundle.js', module: 'amd', outDir: './dist' },
      base: {},
    },
  ])('does not create output intent for $name', async ({ own, base }) => {
    const f = await fixture({
      'packages/app/tsconfig.base.json': json({ compilerOptions: base }),
      'packages/app/tool/tsconfig.json': json({
        extends: '../tsconfig.base.json',
        compilerOptions: own,
        files: ['./src/index.ts'],
      }),
      'packages/app/tool/src/index.ts': 'export const tool = 1;',
    });
    try {
      expect((await f.run()).inputConsumable).toBe(true);
      expect(await f.read('packages/app/tool/tsconfig.json')).toMatchObject({
        extends: '../tsconfig.base.json',
        compilerOptions: own,
      });
      expect(
        (await f.read('packages/app/tool/tsconfig.json')).liminaOptions,
      ).toBeUndefined();
    } finally {
      await f.cleanup();
    }
  });

  it('persists exact bad-entry isolation without deactivating its package', async () => {
    const f = await fixture({ 'packages/app/tsconfig.json': '{ invalid' });
    try {
      const result = await f.run();
      expect(result.inputConsumable).toBe(true);
      expect(await readFile(f.path('packages/app/tsconfig.json'), 'utf8')).toBe(
        '{ invalid',
      );
      const configText = await readFile(f.path('limina.config.mjs'), 'utf8');
      expect(configText).toContain('"kind": "tsconfig"');
      expect(configText).toContain('packages/app/tsconfig.json');
      const { topologies } = (await f.report()).verification;
      for (const topology of topologies)
        expect(topology.sources).toEqual([
          f.path('packages/app/good/tsconfig.json'),
        ]);
      expect((await f.rerunFresh()).result.modifiedFiles).toEqual([]);
      expect(await readFile(f.path('limina.config.mjs'), 'utf8')).toBe(
        configText,
      );
    } finally {
      await f.cleanup();
    }
  });

  it('removes every cross-directory membership into a bad named leaf and preserves empty solutions', async () => {
    const f = await fixture({
      'packages/app/a/tsconfig.json': solution('../shared/tsconfig.lib.json'),
      'packages/app/b/tsconfig.json': solution('../shared/tsconfig.lib.json'),
      'packages/app/c/tsconfig.wrap.json': solution(
        '../shared/tsconfig.lib.json',
        '../good/tsconfig.json',
      ),
      'packages/app/shared/tsconfig.lib.json': '{ invalid',
    });
    try {
      expect((await f.run()).inputConsumable).toBe(true);
      for (const parent of ['a', 'b'])
        expect(
          await f.read(`packages/app/${parent}/tsconfig.json`),
        ).toMatchObject({ files: [], references: [] });
      expect(
        (await f.report()).records.filter(
          (record) => record.kind === 'removed-membership',
        ),
      ).toHaveLength(3);
      expect(
        (await f.read('packages/app/c/tsconfig.wrap.json')).references,
      ).toEqual([{ path: '../good/tsconfig.json' }]);
      expect((await f.rerunFresh()).result.modifiedFiles).toEqual([]);
    } finally {
      await f.cleanup();
    }
  });

  it('expands a shared named wrapper for all parents with rebased deduplicated paths', async () => {
    const f = await fixture({
      'packages/app/a/tsconfig.json': solution(
        '../shared/tsconfig.wrap.json',
        '../shared/tsconfig.lib.json',
      ),
      'packages/app/b/tsconfig.json': solution('../shared/tsconfig.wrap.json'),
      'packages/app/shared/tsconfig.wrap.json': solution('./tsconfig.lib.json'),
      'packages/app/shared/tsconfig.lib.json': source(),
      'packages/app/shared/src/index.ts': 'export const value = 1;',
    });
    try {
      const wrapper = await readFile(
        f.path('packages/app/shared/tsconfig.wrap.json'),
      );
      expect((await f.run()).inputConsumable).toBe(true);
      for (const parent of ['a', 'b'])
        expect(
          (await f.read(`packages/app/${parent}/tsconfig.json`)).references,
        ).toEqual([{ path: '../shared/tsconfig.lib.json' }]);
      expect(
        await readFile(f.path('packages/app/shared/tsconfig.wrap.json')),
      ).toEqual(wrapper);
    } finally {
      await f.cleanup();
    }
  });

  it('expands cyclic named wrappers without losing either source member', async () => {
    const f = await fixture({
      'packages/app/tsconfig.json': solution('./a/tsconfig.wrap.json'),
      'packages/app/a/tsconfig.wrap.json': solution(
        '../b/tsconfig.wrap.json',
        '../x/tsconfig.lib.json',
      ),
      'packages/app/b/tsconfig.wrap.json': solution(
        '../a/tsconfig.wrap.json',
        '../y/tsconfig.lib.json',
      ),
      'packages/app/x/tsconfig.lib.json': source(),
      'packages/app/x/src/index.ts': 'export const x = 1;',
      'packages/app/y/tsconfig.lib.json': source(),
      'packages/app/y/src/index.ts': 'export const y = 1;',
    });
    try {
      expect((await f.run()).inputConsumable).toBe(true);
      const { topologies } = (await f.report()).verification;
      for (const topology of topologies)
        expect(
          topology.reachableSources[f.path('packages/app/tsconfig.json')],
        ).toEqual([
          f.path('packages/app/x/tsconfig.lib.json'),
          f.path('packages/app/y/tsconfig.lib.json'),
        ]);
      expect((await f.rerunFresh()).result.modifiedFiles).toEqual([]);
    } finally {
      await f.cleanup();
    }
  });

  it('compensates solution cycle removal for each retained entry', async () => {
    const f = await fixture({
      'packages/app/a/tsconfig.json': solution(
        '../b/tsconfig.json',
        '../x/tsconfig.lib.json',
      ),
      'packages/app/b/tsconfig.json': solution(
        '../a/tsconfig.json',
        '../y/tsconfig.lib.json',
      ),
      'packages/app/x/tsconfig.lib.json': source(),
      'packages/app/x/src/index.ts': 'export const x = 1;',
      'packages/app/y/tsconfig.lib.json': source(),
      'packages/app/y/src/index.ts': 'export const y = 1;',
    });
    try {
      expect((await f.run()).inputConsumable).toBe(true);
      expect((await f.read('packages/app/b/tsconfig.json')).references).toEqual(
        [
          { path: '../y/tsconfig.lib.json' },
          { path: '../x/tsconfig.lib.json' },
        ],
      );
      const { topologies } = (await f.report()).verification;
      for (const topology of topologies)
        for (const parent of ['a', 'b'])
          expect(
            topology.reachableSources[
              f.path(`packages/app/${parent}/tsconfig.json`)
            ],
          ).toEqual([
            f.path('packages/app/x/tsconfig.lib.json'),
            f.path('packages/app/y/tsconfig.lib.json'),
          ]);
    } finally {
      await f.cleanup();
    }
  });

  it('reports dynamic configuration isolation as incomplete while processing independent sources', async () => {
    const f = await fixture({
      'limina.config.mjs': 'export default async () => ({});\n',
      'packages/app/bad/tsconfig.json': '{ invalid',
    });
    try {
      const result = await f.run();
      expect(result.processingComplete).toBe(true);
      expect(result.inputConsumable).toBe(false);
      expect(result.modifiedFiles).toContain(
        f.path('packages/app/good/tsconfig.json'),
      );
      expect(await readFile(f.path('limina.config.mjs'), 'utf8')).toBe(
        'export default async () => ({});\n',
      );
      expect(
        (await f.report()).records.some(
          (entry) => entry.kind === 'exclusions-not-persisted',
        ),
      ).toBe(true);
    } finally {
      await f.cleanup();
    }
  });

  it('keeps committed adoption when report publication fails', async () => {
    const f = await fixture({
      '.limina/migration': 'blocked report directory',
    });
    try {
      const result = await f.run();
      expect(result.inputConsumable).toBe(true);
      expect(result.reportWarning).toContain('publication failed');
      expect(
        (await f.read('packages/app/good/tsconfig.json')).$schema,
      ).toBeDefined();
    } finally {
      await f.cleanup();
    }
  });
  it.each([false, true])(
    'compares independently inferred source relations and preserves existing implicit reasons (deny=%s)',
    async (denied) => {
      const f = await fixture({
        'limina.config.mjs': `export default ${json(
          denied
            ? {
                graph: {
                  rules: {
                    app: {
                      deny: {
                        refs: [
                          {
                            path: 'packages/app/b/tsconfig.json',
                            reason: 'Fixture governance restriction',
                          },
                        ],
                      },
                    },
                  },
                },
              }
            : {},
        )};`,
        'packages/app/a/tsconfig.json': json({
          files: ['./index.ts'],
          references: [{ path: '../b' }, { path: '../c' }],
          liminaOptions: {
            graphRules: ['app'],
            implicitRefs: [{ path: '../c', reason: 'user contract' }],
          },
        }),
        'packages/app/a/index.ts':
          "import type { B } from '../b/index'; import type { D } from '../d/index'; export type A = B & D;",
        'packages/app/b/tsconfig.json': json({ files: ['index.ts'] }),
        'packages/app/b/index.ts': 'export interface B { b: string }',
        'packages/app/c/tsconfig.json': json({ files: ['index.ts'] }),
        'packages/app/c/index.ts': 'export interface C { c: string }',
        'packages/app/d/tsconfig.json': json({ files: ['index.ts'] }),
        'packages/app/d/index.ts': 'export interface D { d: string }',
      });
      try {
        expect((await f.run()).inputConsumable).toBe(true);
        const config = await f.read('packages/app/a/tsconfig.json');
        expect(config.references).toBeUndefined();
        expect(config.liminaOptions.implicitRefs).toEqual([
          { path: '../c', reason: 'user contract' },
        ]);
        const report = await f.report();
        expect(
          report.records.find((record) => record.kind === 'dependency-analysis')
            ?.message,
        ).toBe('complete');
        expect(
          report.records
            .filter((record) => record.kind === 'native-comparison')
            .map((record) => record.message),
        ).toEqual(['N ∩ G', 'N - G']);
        expect(
          report.records
            .filter((record) => record.kind === 'inferred-only')
            .map((record) => record.details.toConfigPath),
        ).toEqual([f.path('packages/app/d/tsconfig.json')]);
      } finally {
        await f.cleanup();
      }
    },
  );

  it('reports incomplete comparison for illegal named checker entries without fabricating an empty graph', async () => {
    const f = await fixture({
      'limina.config.mjs':
        'export default {config:{checkers:{tsc:{include:["packages/app/named/tsconfig.lib.json"]}}}};',
      'packages/app/named/tsconfig.lib.json': json({ files: ['index.ts'] }),
      'packages/app/named/index.ts': 'export {};',
      'packages/app/a/tsconfig.json': json({
        files: ['index.ts'],
        references: [{ path: '../good' }],
      }),
      'packages/app/a/index.ts': 'export {};',
    });
    try {
      const result = await f.run();
      expect(result.processingComplete).toBe(true);
      expect(result.inputConsumable).toBe(false);
      const report = await f.report();
      expect(
        report.records.find((record) => record.kind === 'dependency-analysis')
          ?.message,
      ).toContain('incomplete');
      expect(
        report.records
          .filter((record) => record.kind === 'native-comparison')
          .map((record) => record.message),
      ).toEqual(['comparison unavailable; preserving explicit declaration']);
      expect(
        (await f.read('packages/app/a/tsconfig.json')).liminaOptions
          .implicitRefs,
      ).toHaveLength(1);
    } finally {
      await f.cleanup();
    }
  });

  it('normalizes a single implicit declaration and isolates invalid shapes without losing healthy siblings', async () => {
    const f = await fixture({
      'packages/app/a/tsconfig.json': json({
        files: ['index.ts'],
        liminaOptions: {
          implicitRefs: { path: '../good', reason: '  ' },
          outputs: {},
        },
      }),
      'packages/app/a/index.ts': 'export {};',
      'packages/app/b/tsconfig.json': json({
        files: ['index.ts'],
        liminaOptions: { implicitRefs: [{ path: 123, reason: 'invalid' }] },
      }),
      'packages/app/b/index.ts': 'export {};',
      'packages/app/c/tsconfig.json': json({
        files: ['index.ts'],
        liminaOptions: { outputs: { outDir: 123 } },
      }),
      'packages/app/c/index.ts': 'export {};',
      'packages/app/d/tsconfig.json': json({
        files: ['index.ts'],
        liminaOptions: [],
      }),
      'packages/app/d/index.ts': 'export {};',
    });
    try {
      expect((await f.run()).inputConsumable).toBe(true);
      const normalized = await f.read('packages/app/a/tsconfig.json');
      expect(normalized.liminaOptions.outputs).toEqual({});
      expect(normalized.liminaOptions.implicitRefs).toEqual([
        {
          path: '../good',
          reason: '保留迁移前已有的显式 implicitRef；原声明未提供 reason',
        },
      ]);
      const report = await f.report();
      expect(
        report.records
          .filter((record) => record.kind === 'isolated')
          .map((record) => record.configPath),
      ).toEqual(
        ['b', 'c', 'd'].map((name) =>
          f.path(`packages/app/${name}/tsconfig.json`),
        ),
      );
      for (const topology of report.verification.topologies)
        expect(topology.sources).toEqual([
          f.path('packages/app/a/tsconfig.json'),
          f.path('packages/app/good/tsconfig.json'),
        ]);
    } finally {
      await f.cleanup();
    }
  });

  it('isolates every consumer of a malformed shared base without rewriting extends or the base', async () => {
    const consumer = json({
      extends: '../tsconfig.base.json',
      files: ['index.ts'],
    });
    const f = await fixture({
      'packages/app/tsconfig.base.json': '{ broken',
      'packages/app/a/tsconfig.json': consumer,
      'packages/app/a/index.ts': 'export {};',
      'packages/app/b/tsconfig.json': consumer,
      'packages/app/b/index.ts': 'export {};',
    });
    try {
      expect((await f.run()).inputConsumable).toBe(true);
      expect(
        await readFile(f.path('packages/app/tsconfig.base.json'), 'utf8'),
      ).toBe('{ broken');
      for (const name of ['a', 'b'])
        expect(
          await readFile(f.path(`packages/app/${name}/tsconfig.json`), 'utf8'),
        ).toBe(consumer);
      const { topologies } = (await f.report()).verification;
      for (const topology of topologies)
        expect(topology.sources).toEqual([
          f.path('packages/app/good/tsconfig.json'),
        ]);
    } finally {
      await f.cleanup();
    }
  });

  it('does not relabel an existing visibility cycle as a rejected optional adoption', async () => {
    const original = json({
      compilerOptions: { outDir: '.' },
      files: ['index.ts'],
      liminaOptions: { outputs: { outDir: '.' } },
    });
    const f = await fixture({
      'packages/app/tool/tsconfig.json': original,
      'packages/app/tool/index.ts': 'export {};',
    });
    try {
      const result = await f.run();
      expect(result.inputConsumable).toBe(false);
      expect(
        await readFile(f.path('packages/app/tool/tsconfig.json'), 'utf8'),
      ).toBe(original);
      expect(
        (await f.report()).records.filter(
          (record) => record.kind === 'output-rejected',
        ),
      ).toEqual([]);
    } finally {
      await f.cleanup();
    }
  });

  it('does not read or adopt an outside native reference', async () => {
    const f = await fixture({
      'limina.config.mjs': `export default { regions: { exclude: [{ kind: 'package-scope', include: ['outside'], reason: 'Independent external fixture' }] } };`,
      'outside/package.json': json({ name: 'outside', private: true }),
      'outside/tsconfig.json': '{ invalid external target',
      'packages/app/a/tsconfig.json': json({
        files: ['index.ts'],
        references: [{ path: '../../../outside/tsconfig.json' }],
      }),
      'packages/app/a/index.ts': 'export {};',
    });
    const originalRead = ts.sys.readFile;
    const originalRealpath = fs.realpathSync.native;
    const outsideReads: string[] = [];
    const read = vi
      .spyOn(ts.sys, 'readFile')
      .mockImplementation((file, encoding) => {
        if (file === f.path('outside/tsconfig.json'))
          outsideReads.push(new Error('Outside config read').stack!);
        return originalRead(file, encoding);
      });
    const realpathRead = vi
      .spyOn(fs.realpathSync, 'native')
      .mockImplementation((file, options) => {
        if (file === f.path('outside/tsconfig.json'))
          outsideReads.push('Outside config physical-path probe');
        return originalRealpath(file, options);
      });
    try {
      const result = await f.run();
      expect(result.inputConsumable).toBe(true);
      expect(result.outsideReferenceCount).toBe(1);
      expect(outsideReads).toEqual([]);
      const target = await f.read('packages/app/a/tsconfig.json');
      expect(target.references).toBeUndefined();
      expect(target.liminaOptions).toBeUndefined();
      expect(
        (await f.report()).records.find(
          (record) => record.kind === 'removed-native-reference',
        )?.message,
      ).toBe('outside activated config topology');
      expect(await readFile(f.path('outside/tsconfig.json'), 'utf8')).toBe(
        '{ invalid external target',
      );
    } finally {
      read.mockRestore();
      realpathRead.mockRestore();
      await f.cleanup();
    }
  });

  it('does not claim consumption when required config isolation is skipped, while independent source writes survive', async () => {
    const f = await fixture({ 'packages/app/tsconfig.json': '{ invalid' });
    try {
      await link(f.path('limina.config.mjs'), f.path('linked-config.mjs'));
      const result = await f.run({
        selectHardlinkStrategy: async () => 'skip',
      });
      expect(result.processingComplete).toBe(true);
      expect(result.inputConsumable).toBe(false);
      expect(result.incompleteFiles).toContain(f.path('limina.config.mjs'));
      expect(result.modifiedFiles).toContain(
        f.path('packages/app/good/tsconfig.json'),
      );
      expect(await readFile(f.path('limina.config.mjs'), 'utf8')).toBe(
        'export default {};\n',
      );
      expect(await readFile(f.path('packages/app/tsconfig.json'), 'utf8')).toBe(
        '{ invalid',
      );
    } finally {
      await f.cleanup();
    }
  });
});
