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
import { NativeAnalysisCache } from '../core/analysis-cache/native-cache';
import { serializeAnalysisSnapshot } from '../core/analysis-cache/snapshot-receipts';
import { parseAnalysisSnapshot } from '../core/analysis-cache/snapshot-schema';
import { collectConfigTypeInputs } from '../core/build-graph/config-type-inputs';
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
  const encoded = serializeAnalysisSnapshot(cache.snapshot());
  const snapshot = parseAnalysisSnapshot(JSON.parse(encoded), 'fixture');
  expect(snapshot).toBeDefined();
  return new NativeAnalysisCache('fixture', snapshot, 'config');
}

it('restores real type entry queries without resolving again and prunes unused query roots', () => {
  const f = fixture();
  f.write('env.d.ts', 'export {};');
  f.write('types/env/index.d.ts', 'export {};');
  const first = new NativeAnalysisCache('fixture', undefined, 'config');
  expect(f.collect(first, ['./env'])).toEqual([
    { name: './env', target: f.file('types/env/index.d.ts') },
  ]);
  expect(f.resolve).toHaveBeenCalledTimes(1);
  const warm = restored(first);
  expect(f.collect(warm, ['./env'])).toEqual([
    { name: './env', target: f.file('types/env/index.d.ts') },
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
    { name: './env', target: null },
  ]);
  const warm = restored(first);
  expect(f.collect(warm, ['./env'])).toEqual([{ name: './env', target: null }]);
  expect(f.resolve).toHaveBeenCalledTimes(1);
  f.write('types/env/index.d.ts', 'export {};');
  expect(f.collect(restored(warm), ['./env'])).toEqual([
    { name: './env', target: f.file('types/env/index.d.ts') },
  ]);
  expect(f.resolve).toHaveBeenCalledTimes(2);
});

it('observes wildcard type enumeration independently of unchanged selected entries', () => {
  const f = fixture();
  f.write('types/one/index.d.ts', 'export {};');
  const first = new NativeAnalysisCache('fixture', undefined, 'config');
  expect(f.collect(first, ['*'])).toEqual([
    { name: 'one', target: f.file('types/one/index.d.ts') },
  ]);
  const warm = restored(first);
  f.collect(warm, ['*']);
  expect(f.resolve).toHaveBeenCalledTimes(1);
  f.write('types/two/index.d.ts', 'export {};');
  expect(f.collect(restored(warm), ['*'])).toEqual([
    { name: 'one', target: f.file('types/one/index.d.ts') },
    { name: 'two', target: f.file('types/two/index.d.ts') },
  ]);
  expect(f.resolve).toHaveBeenCalledTimes(2);
});
