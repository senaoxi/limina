import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { afterEach, expect, it, vi } from 'vitest';
import { loadConfig } from '../config/loader';
import { NativeAnalysisCache } from '../core/analysis-cache/native-cache';
import { parseAnalysisSnapshot } from '../core/analysis-cache/snapshot-schema';
import { collectConfigTypeInputs } from '../core/build-graph/config-type-inputs';
import { LiminaPreflightManager } from '../preflight';
import { roundTripAnalysisSnapshot } from './helpers/analysis-snapshot';
import { createFixturePathResolver } from './helpers/path';

const fixtures: string[] = [];
afterEach(() => {
  for (const root of fixtures.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'limina-type-inputs-'));
  const root = realpathSync.native(directory);
  fixtures.push(root);
  const file = createFixturePathResolver(root);
  const write = (name: string, text: string) => {
    mkdirSync(path.dirname(file(name)), { recursive: true });
    writeFileSync(file(name), text);
  };
  write('tsconfig.json', '{}');
  const resolve = vi.fn(ts.resolveTypeReferenceDirective);
  const compiler = { ...ts, resolveTypeReferenceDirective: resolve };
  const collect = (cache: NativeAnalysisCache, types: string[]) =>
    collectConfigTypeInputs({
      compiler,
      configPath: file('tsconfig.json'),
      options: {
        configFilePath: file('tsconfig.json'),
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        typeRoots: [file('types')],
        types,
      },
      cache,
    });
  return { file, write, resolve, collect };
}

function restored(cache: NativeAnalysisCache): NativeAnalysisCache {
  const snapshot = parseAnalysisSnapshot(
    roundTripAnalysisSnapshot(cache.snapshot()),
    'fixture',
  );
  expect(snapshot).toBeDefined();
  return new NativeAnalysisCache('fixture', snapshot, 'config');
}

it('restores real type entry queries without resolving again and prunes unused query roots', () => {
  const f = fixture();
  f.write('env.d.ts', 'export {};');
  f.write('types/env/index.d.ts', 'export {};');
  const first = new NativeAnalysisCache('fixture', undefined, 'config');
  expect(f.collect(first, ['./env'])).toEqual([
    {
      name: './env',
      target: f.file('types/env/index.d.ts'),
      originalPath: null,
      isExternalLibraryImport: false,
    },
  ]);
  expect(f.resolve).toHaveBeenCalledTimes(1);
  const warm = restored(first);
  expect(f.collect(warm, ['./env'])).toEqual([
    {
      name: './env',
      target: f.file('types/env/index.d.ts'),
      originalPath: null,
      isExternalLibraryImport: false,
    },
  ]);
  expect(f.resolve).toHaveBeenCalledTimes(1);
  const empty = restored(warm);
  expect(f.collect(empty, [])).toEqual([]);
  expect(empty.snapshot().queries).toEqual({});
});

it('invalidates a complete miss when the typeRoots candidate appears', () => {
  const f = fixture();
  f.write('env.d.ts', 'export {};');
  const first = new NativeAnalysisCache('fixture', undefined, 'config');
  expect(f.collect(first, ['./env'])).toEqual([
    {
      name: './env',
      target: null,
      originalPath: null,
      isExternalLibraryImport: false,
    },
  ]);
  const warm = restored(first);
  expect(f.collect(warm, ['./env'])).toEqual([
    {
      name: './env',
      target: null,
      originalPath: null,
      isExternalLibraryImport: false,
    },
  ]);
  expect(f.resolve).toHaveBeenCalledTimes(1);
  f.write('types/env/index.d.ts', 'export {};');
  expect(f.collect(restored(warm), ['./env'])).toEqual([
    {
      name: './env',
      target: f.file('types/env/index.d.ts'),
      originalPath: null,
      isExternalLibraryImport: false,
    },
  ]);
  expect(f.resolve).toHaveBeenCalledTimes(2);
});

it('observes wildcard type enumeration independently of unchanged selected entries', () => {
  const f = fixture();
  f.write('types/one/index.d.ts', 'export {};');
  const first = new NativeAnalysisCache('fixture', undefined, 'config');
  expect(f.collect(first, ['*'])).toEqual([
    {
      name: 'one',
      target: f.file('types/one/index.d.ts'),
      originalPath: null,
      isExternalLibraryImport: false,
    },
  ]);
  const warm = restored(first);
  f.collect(warm, ['*']);
  expect(f.resolve).toHaveBeenCalledTimes(1);
  f.write('types/two/index.d.ts', 'export {};');
  expect(f.collect(restored(warm), ['*'])).toEqual([
    {
      name: 'one',
      target: f.file('types/one/index.d.ts'),
      originalPath: null,
      isExternalLibraryImport: false,
    },
    {
      name: 'two',
      target: f.file('types/two/index.d.ts'),
      originalPath: null,
      isExternalLibraryImport: false,
    },
  ]);
  expect(f.resolve).toHaveBeenCalledTimes(2);
});

it('publishes a sibling config type input on the first run and rejects its move behind a stopped boundary', async () => {
  const f = fixture();
  f.write(
    'tsconfig.json',
    JSON.stringify({
      files: [],
      references: [{ path: './packages/a' }, { path: './packages/b' }],
    }),
  );
  f.write('package.json', JSON.stringify({ name: 'root', private: true }));
  f.write('pnpm-workspace.yaml', 'packages:\n  - packages/*\n');
  f.write(
    'limina.config.mjs',
    'export default {scope:{checkers:{tsc:{include:["packages/*/tsconfig.json"]}}}};',
  );
  for (const name of ['a', 'b'])
    f.write(`packages/${name}/package.json`, JSON.stringify({ name }));
  const compilerOptions = { module: 'NodeNext', noLib: true, types: [] };
  const setTypeInput = (name: string, typeRoots?: string[]) =>
    f.write(
      'packages/a/tsconfig.json',
      JSON.stringify({
        compilerOptions: { ...compilerOptions, types: [name], typeRoots },
        files: ['entry.ts'],
      }),
    );
  setTypeInput('../b/env.d.ts');
  f.write('packages/a/entry.ts', 'export type T = Shared;');
  f.write('packages/b/env.d.ts', 'interface Shared { value: string }');
  f.write(
    'packages/b/tsconfig.json',
    JSON.stringify({ compilerOptions, files: ['env.d.ts'] }),
  );
  const prepare = async () => {
    const config = await loadConfig({
      configPath: f.file('limina.config.mjs'),
    });
    const manager = new LiminaPreflightManager({ config, analysisCache: true });
    try {
      const { graph } = await manager.ensureGeneratedArtifactsMaterialized();
      await manager.publishAnalysisCache();
      return graph.manifest.dependencyEdges;
    } finally {
      manager.dispose();
    }
  };
  const cold = await prepare();
  expect(cold).toEqual([
    expect.objectContaining({
      file: 'packages/a/tsconfig.json',
      fromConfig: 'packages/a/tsconfig.json',
      importedSpecifier: '../b/env.d.ts',
      toConfig: 'packages/b/tsconfig.json',
    }),
  ]);
  expect(await prepare()).toEqual(cold);
  f.write('packages/a/empty-types/.keep', '');
  setTypeInput('../b/env.d.ts', ['./empty-types']);
  expect(await prepare()).toEqual([]);
  f.write('packages/b/cut/package.json', '{"name":"stopped"}');
  f.write('packages/b/cut/env.d.ts', 'interface Shared { value: number }');
  setTypeInput('../b/cut/env.d.ts');
  await expect(prepare()).rejects.toThrow(
    /outside activated workspace package regions/u,
  );
});
