import { compareCodeUnits } from '#utils/collections';
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
import { afterEach, describe, expect, it } from 'vitest';
import { NativeAnalysisCache } from '../core/analysis-cache/native-cache';
import { parseAnalysisSnapshot } from '../core/analysis-cache/snapshot-schema';
import {
  createTypeScriptDependencyContext,
  createWorkspaceSourceBoundary,
} from '../core/typescript-semantic';
import type { TypeScriptSemanticProject } from '../core/typescript-semantic/contracts';
import { roundTripAnalysisSnapshot } from './helpers/analysis-snapshot';
import { createFixturePathResolver } from './helpers/path';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const temporary = mkdtempSync(path.join(tmpdir(), 'limina-programless-'));
  const root = realpathSync.native(temporary);
  roots.push(root);
  const file = createFixturePathResolver(root);
  const write = (name: string, text: string) => {
    mkdirSync(path.dirname(file(name)), { recursive: true });
    writeFileSync(file(name), text);
  };
  write('tsconfig.json', '{}');
  const project = (
    names: string[],
    options: ts.CompilerOptions = {},
  ): TypeScriptSemanticProject => ({
    configPath: file('tsconfig.json'),
    fileNames: names.map((name) => file(name)),
    admissionMode: 'full-program',
    analysisBinding: { phase: 'locked', checker: 'tsc' },
    options: {
      noLib: true,
      types: [],
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      ...options,
    },
    workspaceSourceBoundary: createWorkspaceSourceBoundary([
      file('a.ts'),
      file('a.tsx'),
      file('b.ts'),
      file('c.ts'),
    ]),
  });
  return { file, write, project };
}

function collect(
  project: TypeScriptSemanticProject,
  previous?: NativeAnalysisCache,
) {
  const restored =
    previous === undefined
      ? undefined
      : parseAnalysisSnapshot(serializedSnapshot(previous), 'test', 'config');
  if (previous !== undefined) expect(restored).toBeDefined();
  const cache = new NativeAnalysisCache('test', restored, 'config');
  const context =
    cache.restoreContext(project) ??
    createTypeScriptDependencyContext(project, { analysisCache: cache });
  const members = [...context.getContributionFileNames!()];
  const records = members.flatMap((file) => [
    ...context.getImportRecords(file),
  ]);
  const facts = records.map((record) => context.getDependencyFact(record));
  const targets = [
    ...new Set(
      facts.flatMap((fact) =>
        fact.referenceRequirement === null
          ? []
          : [fact.referenceRequirement.targetFileName],
      ),
    ),
  ].sort(compareCodeUnits);
  if ('dispose' in context && typeof context.dispose === 'function')
    context.dispose();
  return { cache, records, facts, members, targets };
}

describe('programless dependency contracts', () => {
  it.each([
    'import "./b"; export {};',
    'export * from "./b";',
    'import type {Value} from "./b"; export type {Value};',
    'export type Value = import("./b").Value;',
    'export const value = import("./b");',
    'const value = require("./b"); export {value};',
    'import value = require("./b"); export {value};',
    'import {createRequire} from "node:module"; const load = createRequire(import.meta.url); export const value = load("./b");',
  ])('retains a resolved implementation requirement: %s', (source) => {
    const f = fixture();
    f.write('a.ts', source);
    f.write('b.ts', 'export interface Value {}');
    const result = collect(f.project(['a.ts']));
    expect(result.targets).toEqual([f.file('b.ts')]);
    expect(result.members).not.toContain(f.file('b.ts'));
    expect(result.cache.metrics.semanticPrograms).toBe(0);
  });

  it.each([
    'function f(require: (x:string)=>unknown) { return require("./b"); } export {};',
    'function f(loader: (x:string)=>unknown) { return loader("./b"); } export {};',
  ])(
    'does not treat a shadowed TypeScript loader as a module request: %s',
    (source) => {
      const f = fixture();
      f.write('a.ts', source);
      f.write('b.ts', 'export {};');
      expect(collect(f.project(['a.ts'])).targets).toEqual([]);
    },
  );

  it('separates augmentation resolution from declaration admission and script ambient names', () => {
    const f = fixture();
    f.write(
      'a.ts',
      'export {}; declare module "./b" {} declare module "./env" {}',
    );
    f.write('b.ts', 'export {};');
    f.write('env.d.ts', 'import "./c"; export {};');
    f.write('c.ts', 'export {};');
    let result = collect(f.project(['a.ts']));
    expect(result.targets).toEqual([f.file('b.ts')]);
    expect(result.members).not.toContain(f.file('env.d.ts'));
    f.write('a.ts', 'declare module "./b" {}');
    result = collect(f.project(['a.ts']), result.cache);
    expect(result.targets).toEqual([]);
    result = collect(
      f.project(['a.ts'], { moduleDetection: ts.ModuleDetectionKind.Force }),
      result.cache,
    );
    expect(result.targets).toEqual([f.file('b.ts')]);
  });

  it.each([
    {
      loader: 'require',
      skipLibCheck: false,
      noResolve: false,
      independent: false,
    },
    {
      loader: 'require',
      skipLibCheck: true,
      noResolve: false,
      independent: false,
    },
    {
      loader: 'loader',
      skipLibCheck: false,
      noResolve: false,
      independent: false,
    },
    {
      loader: 'require',
      skipLibCheck: false,
      noResolve: true,
      independent: false,
    },
    {
      loader: 'require',
      skipLibCheck: false,
      noResolve: true,
      independent: true,
    },
    {
      loader: 'loader',
      skipLibCheck: false,
      noResolve: false,
      independent: true,
    },
  ])(
    'preserves qualified JS compiler support separately from runtime calls: %j',
    (input) => {
      const f = fixture();
      f.write(
        'a.js',
        `function use(${input.loader}) { return ${input.loader}("./env"); } export {};`,
      );
      f.write(
        'env.d.ts',
        'import type {Value} from "./b"; export declare const value: Value;',
      );
      f.write('b.ts', 'export interface Value { n: number }');
      const project = f.project(
        input.independent ? ['a.js', 'env.d.ts'] : ['a.js'],
        {
          allowJs: true,
          checkJs: true,
          composite: true,
          configFilePath: f.file('tsconfig.json'),
          skipLibCheck: input.skipLibCheck,
          noResolve: input.noResolve,
        },
      );
      const program = ts.createProgram({
        rootNames: project.fileNames,
        options: project.options,
      });
      const isLoaded =
        input.independent || (input.loader === 'require' && !input.noResolve);
      expect(program.getSourceFile(f.file('env.d.ts')) !== undefined).toBe(
        isLoaded,
      );
      expect(program.getSourceFile(f.file('b.ts')) !== undefined).toBe(
        isLoaded && !input.noResolve,
      );
      expect(
        ts
          .getPreEmitDiagnostics(program)
          .some((diagnostic) => diagnostic.code === 6307),
      ).toBe(isLoaded && !input.noResolve && !input.skipLibCheck);
      const result = collect(project);
      expect(result.members.includes(f.file('env.d.ts'))).toBe(isLoaded);
      expect(result.targets.includes(f.file('b.ts'))).toBe(isLoaded);
      expect(
        result.records.filter((record) => record.filePath === f.file('a.js')),
      ).toEqual([]);
    },
  );

  it('retains noResolve implementation edges and independently admitted declarations', () => {
    const f = fixture();
    f.write('a.ts', 'import "./b"; import "./env"; export {};');
    f.write('b.ts', 'export {};');
    f.write('env.d.ts', 'import "./c"; export {};');
    f.write('c.ts', 'export {};');
    const first = collect(f.project(['a.ts'], { noResolve: true }));
    expect(first.targets).toEqual([f.file('b.ts')]);
    expect(first.members).not.toContain(f.file('env.d.ts'));
    const next = collect(
      f.project(['a.ts', 'env.d.ts'], { noResolve: true }),
      first.cache,
    );
    expect(next.targets).toEqual([f.file('b.ts'), f.file('c.ts')]);
  });

  it('binds one shared TSX syntax fact to distinct implicit runtime contexts', () => {
    const f = fixture();
    f.write('a.tsx', '<div />;');
    for (const name of ['react', 'preact'])
      f.write(`node_modules/${name}/jsx-runtime.d.ts`, 'export {};');
    const cache = new NativeAnalysisCache('test', undefined, 'config');
    const requests: string[][] = [];
    for (const jsxImportSource of ['react', 'preact']) {
      const context = createTypeScriptDependencyContext(
        f.project(['a.tsx'], { jsx: ts.JsxEmit.ReactJSX, jsxImportSource }),
        { analysisCache: cache },
      );
      requests.push(
        context
          .getImportRecords(f.file('a.tsx'))
          .map((record) => record.specifier),
      );
      context.dispose();
    }
    expect(requests).toEqual([['react/jsx-runtime'], ['preact/jsx-runtime']]);
    expect(cache.files[f.file('a.tsx')].requests).toEqual([]);
    expect(cache.metrics.syntaxFactHits).toBeGreaterThan(0);
  });

  it('reuses unchanged queries while updating duplicate occurrence locations and pruning a declaration cycle', () => {
    const f = fixture();
    f.write('a.ts', 'import "./env"; export {};');
    f.write('second.ts', 'import "./env"; export {};');
    f.write('env.d.ts', 'import "./cycle"; import "./b"; export {};');
    f.write('cycle.d.ts', 'import "./env"; export {};');
    f.write('b.ts', 'export {};');
    const project = f.project(['a.ts', 'second.ts']);
    let result = collect(project);
    f.write('a.ts', '\n\nimport "./env"; import "./env"; export {};');
    result = collect(project, result.cache);
    expect(result.cache.metrics.syntaxExtractions).toBe(1);
    expect(result.cache.metrics.resolverCalls).toBe(0);
    expect(
      result.records
        .filter((record) => record.filePath === f.file('a.ts'))
        .map((record) => [record.line, record.locator.occurrence]),
    ).toEqual([
      [3, 0],
      [3, 1],
    ]);
    f.write('a.ts', 'export {};');
    result = collect(project, result.cache);
    expect(result.members).toContain(f.file('cycle.d.ts'));
    f.write('second.ts', 'export {};');
    result = collect(project, result.cache);
    expect(result.members).not.toContain(f.file('cycle.d.ts'));
    expect(result.targets).toEqual([]);
    const snapshot = result.cache.snapshot();
    expect(snapshot.files[f.file('env.d.ts')]).toBeUndefined();
    const retained = Object.values(snapshot.importers).map(
      (importer) => importer.filePath,
    );
    for (const file of ['env.d.ts', 'cycle.d.ts'])
      expect(retained).not.toContain(f.file(file));
  });

  it('invalidates a complete miss when a resolution candidate appears without editing the importer', () => {
    const f = fixture();
    f.write('a.ts', 'import "./b"; export {};');
    const project = f.project(['a.ts']);
    let result = collect(project);
    expect(result.targets).toEqual([]);
    expect(result.cache.metrics.semanticPrograms).toBe(0);
    f.write('b.ts', 'export {};');
    result = collect(project, result.cache);
    expect(result.targets).toEqual([f.file('b.ts')]);
    expect(result.cache.metrics.syntaxExtractions ?? 0).toBe(0);
    expect(result.cache.metrics.resolverCalls).toBe(1);
    expect(result.cache.metrics.semanticPrograms).toBe(0);
  });

  it('atomically switches an incomplete declaration closure to JS compatibility and recovers after removal', () => {
    const f = fixture();
    f.write('a.ts', 'import "./env"; export {};');
    f.write('env.d.ts', 'import "./helper.js"; export {};');
    f.write(
      'helper.js',
      'function f(require) { return require("./nested"); } export {};',
    );
    f.write('nested.d.ts', 'import "./b"; export {};');
    f.write('b.ts', 'export {};');
    const project = f.project(['a.ts'], { allowJs: true, checkJs: true });
    let result = collect(project);
    expect(result.targets).toContain(f.file('b.ts'));
    expect(result.cache.metrics.semanticPrograms).toBe(1);
    result = collect(project, result.cache);
    expect(result.targets).toContain(f.file('b.ts'));
    expect(result.cache.metrics.semanticPrograms).toBe(0);
    f.write('env.d.ts', 'import "./b"; export {};');
    result = collect(project, result.cache);
    expect(result.targets).toEqual([f.file('b.ts')]);
    expect(result.cache.metrics.semanticPrograms).toBe(0);
    expect(
      Object.values(result.cache.contexts).map(
        (context) => context.collection?.mode,
      ),
    ).toEqual(['programless']);
  });
  it.each(['module', 'commonjs'] as const)(
    'uses declaration package scope in Bundler resolution: %s',
    (type) => {
      const f = fixture();
      f.write('a.ts', 'import "pkg";');
      f.write(
        'node_modules/pkg/package.json',
        JSON.stringify({ name: 'pkg', type, types: 'index.d.ts' }),
      );
      f.write(
        'node_modules/pkg/index.d.ts',
        'import type {Value} from "choice";export type T=Value;',
      );
      f.write(
        'node_modules/choice/package.json',
        JSON.stringify({
          name: 'choice',
          exports: { import: './esm.d.ts', require: './cjs.d.ts' },
        }),
      );
      f.write('node_modules/choice/esm.d.ts', 'export interface Value {}');
      f.write('node_modules/choice/cjs.d.ts', 'export interface Value {}');
      const result = collect(f.project(['a.ts']));
      const request = result.records.findIndex(
        (record) => record.specifier === 'choice',
      );
      expect(result.facts[request].resolution.target?.resolvedFileName).toBe(
        f.file(`node_modules/choice/${type === 'module' ? 'esm' : 'cjs'}.d.ts`),
      );
      expect(result.cache.metrics.semanticPrograms).toBe(0);
    },
  );
});

function serializedSnapshot(cache: NativeAnalysisCache): unknown {
  const snapshot = cache.snapshot();
  return roundTripAnalysisSnapshot(snapshot);
}
