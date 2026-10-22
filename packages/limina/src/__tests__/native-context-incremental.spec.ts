import { compareCodeUnits } from '#utils/collections';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { NativeAnalysisCache } from '../core/analysis-cache/native-cache';
import { occurrenceKey } from '../core/analysis-cache/semantic-state';
import { parseAnalysisSnapshot } from '../core/analysis-cache/snapshot-schema';
import {
  createTypeScriptDependencyContext,
  createWorkspaceSourceBoundary,
} from '../core/typescript-semantic';
import type { TypeScriptSemanticProject } from '../core/typescript-semantic/contracts';
import { summarizeCompilationObligation } from '../domain/analysis/native-obligation';
import { roundTripAnalysisSnapshot } from './helpers/analysis-snapshot';
import { readFixtureSourceCoverage } from './helpers/native-coverage';
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
  const fixtureFiles = new Set<string>();
  const write = (name: string, text: string) => {
    fixtureFiles.add(name);
    mkdirSync(path.dirname(file(name)), { recursive: true });
    writeFileSync(file(name), text);
  };
  write('tsconfig.json', '{}');
  const project = (
    names: string[],
    options: ts.CompilerOptions = {},
  ): TypeScriptSemanticProject => {
    // Explicit fixture selection, independent of resolutions and compiler roots.
    const writeConfig = (name: string, members: string[]) => {
      const text = JSON.stringify({
        compilerOptions: { allowJs: true },
        files: members,
      });
      if (!existsSync(file(name)) || readFileSync(file(name), 'utf8') !== text)
        write(name, text);
    };
    writeConfig('tsconfig.json', names);
    const support = [...fixtureFiles].filter(
      (name) => /\.[cm]?[jt]sx?$/u.test(name) && !names.includes(name),
    );
    writeConfig('tsconfig.support.json', support);
    const selected = [
      'tsconfig.json',
      ...(support.length > 0 ? ['tsconfig.support.json'] : []),
    ];
    return {
      configPath: file('tsconfig.json'),
      fileNames: names.map((name) => file(name)),
      admissionMode: 'coverage-bounded',
      compilationObligationScope: 'generated-declaration-project-v1',
      analysisBinding: { phase: 'locked', checker: 'tsc' },
      options: {
        noLib: true,
        types: [],
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        ...options,
      },
      workspaceSourceBoundary: createWorkspaceSourceBoundary(
        [...names, ...support].map((name) => file(name)),
        undefined,
        readFixtureSourceCoverage(selected.map((name) => file(name))),
      ),
    };
  };
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

describe('bounded compiler context replacement and incremental inputs', () => {
  it('restores a compiler reference endpoint ahead of source Coverage ownership', () => {
    const f = fixture();
    f.write('a.ts', 'import type { Value } from "./b"; export type T = Value;');
    f.write('b.ts', 'export interface Value {}');
    f.write(
      '.limina/provider.json',
      JSON.stringify({
        compilerOptions: {
          composite: true,
          declaration: true,
          noLib: true,
          types: [],
          outDir: 'dts',
        },
        files: ['../b.ts'],
      }),
    );
    const project = {
      ...f.project(['a.ts']),
      projectReferences: [{ path: f.file('.limina/provider.json') }],
    };
    const first = collect(project);
    const evidence = first.facts[0]!.nativeEvidence!;
    expect(evidence.coverage).toMatchObject({
      state: 'unique',
      members: [{ configId: f.file('tsconfig.support.json') }],
    });
    expect(evidence.obligation?.targetConfigId).toBe(
      f.file('.limina/provider.json'),
    );
    const warm = collect(project, first.cache);
    expect(warm.cache.metrics.restoredContexts).toBe(1);
    expect(warm.cache.metrics.semanticPrograms).toBe(0);
    expect(warm.facts).toEqual(first.facts);
  });

  it.each([
    'missing-facts',
    'shifted-range',
    'wrong-kind',
    'missing-member',
  ] as const)(
    'rejects %s before adoption while retaining independent contexts',
    (damage) => {
      const f = fixture();
      f.write(
        'a.js',
        '/** @type {import("./value").Value} */\nexport let value;',
      );
      f.write('value.d.ts', 'export interface Value {}');
      const project = f.project(['a.js', 'value.d.ts'], {
        allowJs: true,
        checkJs: true,
      });
      const first = collect(project);
      const independent = fixture();
      independent.write('independent.ts', 'export const value = 1;');
      const other = independent.project(['independent.ts']);
      createTypeScriptDependencyContext(other, { analysisCache: first.cache });
      const snapshot = first.cache.snapshot();
      const importer = Object.values(snapshot.importers).find(
        (item) => item.filePath === f.file('a.js'),
      )!;
      expect(importer.occurrences).toHaveLength(1);
      if (damage === 'missing-facts') {
        importer.occurrences = [];
        importer.facts = {};
      } else if (damage === 'missing-member') {
        const id = importer.contextId;
        const target = f.file('value.d.ts');
        delete snapshot.contexts[id].sources[target];
        snapshot.projects[id].members = snapshot.projects[id].members.filter(
          (member) => member !== target,
        );
      } else {
        const occurrence = importer.occurrences[0]!;
        const key = occurrenceKey(occurrence);
        const fact = importer.facts[key];
        delete importer.facts[key];
        if (damage === 'wrong-kind') occurrence.kind = 'export';
        else occurrence.locator.sourceEnd += 100_000;
        importer.facts[occurrenceKey(occurrence)] = fact;
      }
      // Call the production restore boundary directly; parsing the store must not
      // be the only defense before graph fallback can reuse a context.
      const cache = new NativeAnalysisCache('test', snapshot, 'config');
      expect(cache.restoreContext(project)).toBeUndefined();
      expect(
        cache
          .restoreContext(other)
          ?.hasSourceFile(independent.file('independent.ts')),
      ).toBe(true);
      expect(cache.metrics.restoredContexts).toBe(1);
      const rebuilt = createTypeScriptDependencyContext(project, {
        analysisCache: cache,
      });
      expect(rebuilt.getImportRecords(f.file('a.js'))).toHaveLength(1);
      expect(
        rebuilt.nativeEvidence?.requests.map((request) => request.specifier),
      ).toContain('./value');
      expect(cache.metrics.semanticPrograms).toBe(1);
    },
  );

  it.each([
    'import "./b"; export {};',
    'export * from "./b";',
    'import type {Value} from "./b"; export type {Value};',
    'export type Value = import("./b").Value;',
    'export const value = import("./b");',
    'import value = require("./b"); export {value};',
  ])('retains a resolved implementation requirement: %s', (source) => {
    const f = fixture();
    f.write('a.ts', source);
    f.write('b.ts', 'export interface Value {}');
    const result = collect(f.project(['a.ts']));
    expect(result.targets).toEqual([f.file('b.ts')]);
    expect(result.members).not.toContain(f.file('b.ts'));
    expect(result.cache.metrics.semanticPrograms).toBe(1);
  });

  it.each([
    'function f(require: (x:string)=>unknown) { return require("./b"); } export {};',
    'function f(loader: (x:string)=>unknown) { return loader("./b"); } export {};',
    'const value = require("./b"); export {value};',
    'import {createRequire} from "node:module"; const load = createRequire(import.meta.url); export const value = load("./b");',
  ])(
    'does not promote TypeScript runtime calls to compiler obligations: %s',
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
    expect(result.targets).toEqual([]);
    expect(result.facts[0]?.nativeEvidence?.obligation?.existence.state).toBe(
      'absent',
    );
    expect(result.members).not.toContain(f.file('env.d.ts'));
    f.write('a.ts', 'declare module "./b" {}');
    result = collect(f.project(['a.ts']), result.cache);
    expect(result.targets).toEqual([]);
    result = collect(
      f.project(['a.ts'], { moduleDetection: ts.ModuleDetectionKind.Force }),
      result.cache,
    );
    expect(result.targets).toEqual([]);
    expect(result.facts[0]?.nativeEvidence?.obligation?.existence.state).toBe(
      'absent',
    );
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
      expect(result.targets.includes(f.file('b.ts'))).toBe(
        isLoaded && !input.noResolve,
      );
      expect(
        result.records.filter((record) => record.filePath === f.file('a.js')),
      ).toHaveLength(input.loader === 'require' ? 1 : 0);
    },
  );

  it('proves request-local noResolve absence while retaining independently admitted declarations', () => {
    const f = fixture();
    f.write('a.ts', 'import "./b"; import "./env"; export {};');
    f.write('b.ts', 'export {};');
    f.write('env.d.ts', 'import "./c"; export {};');
    f.write('c.ts', 'export {};');
    const first = collect(f.project(['a.ts'], { noResolve: true }));
    expect(first.targets).toEqual([]);
    expect(first.members).not.toContain(f.file('env.d.ts'));
    expect(
      Object.values(first.cache.contexts).flatMap((record) =>
        record.native!.snapshot.obligations.map(summarizeCompilationObligation),
      ),
    ).toEqual(['not-required', 'not-required']);
    const next = collect(
      f.project(['a.ts', 'env.d.ts'], { noResolve: true }),
      first.cache,
    );
    expect(next.targets).toEqual([]);
    expect(next.members).toContain(f.file('env.d.ts'));
    expect(
      Object.values(next.cache.contexts).flatMap((record) =>
        record.native!.snapshot.obligations.map(summarizeCompilationObligation),
      ),
    ).toEqual(['not-required', 'not-required', 'not-required']);
  });

  it('collects separate compiler implicit requests for distinct TSX contexts', () => {
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
    expect(cache.metrics.semanticPrograms).toBe(2);
  });

  it('recollects duplicate occurrence locations and prunes the last reachable declaration cycle', () => {
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
    expect(result.cache.metrics.semanticPrograms).toBe(1);
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
    expect(result.cache.metrics.semanticPrograms).toBe(1);
    f.write('b.ts', 'export {};');
    result = collect(f.project(['a.ts']), result.cache);
    expect(result.targets).toEqual([f.file('b.ts')]);
    expect(result.cache.metrics.semanticPrograms).toBe(1);
  });

  it('stops at JS implementations without a full-Program fallback and recollects a changed declaration', () => {
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
    expect(result.targets).toEqual([f.file('helper.js')]);
    expect(result.members).not.toContain(f.file('nested.d.ts'));
    expect(result.cache.metrics.semanticPrograms).toBe(1);
    result = collect(project, result.cache);
    expect(result.targets).toEqual([f.file('helper.js')]);
    expect(result.cache.metrics.semanticPrograms).toBe(0);
    f.write('env.d.ts', 'import "./b"; export {};');
    result = collect(project, result.cache);
    expect(result.targets).toEqual([f.file('b.ts')]);
    expect(result.cache.metrics.semanticPrograms).toBe(1);
    expect(
      Object.values(result.cache.contexts).map(
        (context) => context.project.admissionMode,
      ),
    ).toEqual(['coverage-bounded']);
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
      expect(result.cache.metrics.semanticPrograms).toBe(1);
    },
  );
});

function serializedSnapshot(cache: NativeAnalysisCache): unknown {
  const snapshot = cache.snapshot();
  return roundTripAnalysisSnapshot(snapshot);
}
