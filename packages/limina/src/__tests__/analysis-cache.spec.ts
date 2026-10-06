import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { AnalysisInputDriftError } from '../core/analysis-cache/contracts';
import { AnalysisInputs } from '../core/analysis-cache/inputs';
import { NativeAnalysisCache } from '../core/analysis-cache/native-cache';
import { parseAnalysisSnapshot } from '../core/analysis-cache/snapshot-schema';
import { createImportAnalysisContext } from '../core/import-analysis/runner';
import { createProjectDependencyCaches } from '../core/project-dependencies/cache';
import { collectProjectDependencies } from '../core/project-dependencies/provider';
import { createBoundedTypeScriptSemanticContext } from '../core/typescript-semantic/context';
import type { TypeScriptSemanticProject } from '../core/typescript-semantic/contracts';
import { createWorkspaceSourceBoundary } from '../core/typescript-semantic/workspace-source-boundary';
import { createFixturePathResolver } from './helpers/path';

const fixtures: string[] = [];
afterEach(() => {
  for (const root of fixtures.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const temporary = mkdtempSync(path.join(tmpdir(), 'limina-analysis-cache-'));
  const root = realpathSync(temporary);
  fixtures.push(root);
  const file = createFixturePathResolver(root);
  let revision = Date.now();
  const write = (name: string, text: string) => {
    mkdirSync(path.dirname(file(name)), { recursive: true });
    writeFileSync(file(name), text);
    revision += 1000;
    utimesSync(file(name), revision / 1000, revision / 1000);
  };
  write('tsconfig.json', '{}');
  return { file, write };
}

function analyze(
  project: TypeScriptSemanticProject,
  previous?: NativeAnalysisCache,
) {
  const snapshot =
    previous === undefined
      ? undefined
      : parseAnalysisSnapshot(diskSnapshot(previous), 'fixture');
  if (previous !== undefined) expect(snapshot).toBeDefined();
  const cache = new NativeAnalysisCache('fixture', snapshot);
  const context = createBoundedTypeScriptSemanticContext(project, {
    analysisCache: cache,
  });
  const facts = project.fileNames.flatMap((file) =>
    context
      .getImportRecords(file)
      .map((record) => ({ record, fact: context.getDependencyFact(record) })),
  );
  const members = context.program.getSourceFiles().map((file) => file.fileName);
  const diagnostics = ts
    .getPreEmitDiagnostics(context.program)
    .map((diagnostic) => ({
      code: diagnostic.code,
      file: diagnostic.file?.fileName,
      start: diagnostic.start,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    }));
  context.dispose();
  return { cache, facts, members, diagnostics };
}

function project(
  configPath: string,
  fileNames: string[],
): TypeScriptSemanticProject {
  return {
    analysisBinding: { phase: 'locked', checker: 'tsc' },
    configPath,
    fileNames,
    options: {
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noLib: true,
    },
    workspaceSourceBoundary: createWorkspaceSourceBoundary(fileNames),
  };
}

function expectCold(
  result: ReturnType<typeof analyze>,
  input: TypeScriptSemanticProject,
) {
  const cold = analyze(input);
  expect(result.facts).toEqual(cold.facts);
  expect(result.members).toEqual(cold.members);
  expect(result.diagnostics).toEqual(cold.diagnostics);
}

describe('persistent native analysis facts', () => {
  it('reassembles runtime observations through missing, present and missing while native facts hit', () => {
    const { file, write } = fixture();
    write('a.ts', "import './theme.css'; export {};");
    const context = {
      analysisChecker: 'tsc',
      compilerOptions: {
        noLib: true,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
      },
      configPath: file('tsconfig.json'),
      fileNames: [file('a.ts')],
      extensions: [],
      generation: 0,
      packageRootByFileName: new Map([[file('a.ts'), file()]]),
      packageRootDir: file(),
      references: [],
      resolverConfigPath: file('tsconfig.json'),
      semanticAuthority: {
        family: 'typescript' as const,
        kind: 'locked' as const,
        source: 'explicit' as const,
      },
      workspaceSourceBoundary: createWorkspaceSourceBoundary([file('a.ts')]),
    };
    const collect = (cache: NativeAnalysisCache) =>
      collectProjectDependencies({
        context,
        caches: createProjectDependencyCaches(undefined, cache),
        importAnalysis: createImportAnalysisContext(),
      });
    let cache = new NativeAnalysisCache('fixture');
    let result = collect(cache);
    expect(result.observations[0]?.evidence.runtime?.runtime.kind).toBe(
      'missing',
    );
    for (const isPresent of [true, false]) {
      if (isPresent) write('theme.css', '.theme {}');
      else rmSync(file('theme.css'));
      cache = new NativeAnalysisCache(
        'fixture',
        parseAnalysisSnapshot(diskSnapshot(cache), 'fixture'),
      );
      result = collect(cache);
      expect(result).toEqual(collect(new NativeAnalysisCache('fixture')));
      expect(result.observations[0]?.evidence.runtime?.runtime.kind).toBe(
        isPresent ? 'file' : 'missing',
      );
      expect(cache.metrics.factQueries).toBe(0);
    }
  });

  it('keeps same specifiers isolated by containing file and native checker phase', () => {
    const { file, write } = fixture();
    for (const directory of ['one', 'two']) {
      write(`${directory}/a.ts`, "import { x } from './value'; export { x };");
      write(`${directory}/value.ts`, 'export const x = 1;');
    }
    const input = project(
      file('tsconfig.json'),
      ['one/a.ts', 'two/a.ts'].map((name) => file(name)),
    );
    const first = analyze(input);
    expect(
      first.facts.map(({ fact }) => fact.resolution.target?.resolvedFileName),
    ).toEqual([file('one/value.ts'), file('two/value.ts')]);
    const pending = analyze(
      { ...input, analysisBinding: { phase: 'pending', checker: 'tsc' } },
      first.cache,
    );
    expect(pending.cache.metrics.factHits).toBe(0);
    const tsgo = analyze(
      { ...input, analysisBinding: { phase: 'locked', checker: 'tsgo' } },
      first.cache,
    );
    expect(tsgo.cache.metrics.factHits).toBe(0);
  });

  it('confirms touch with a hash without propagating a content change', () => {
    const { file, write } = fixture();
    const text = "import { x } from './value'; export { x };";
    write('a.ts', text);
    write('value.ts', 'export const x = 1;');
    const input = project(file('tsconfig.json'), [file('a.ts')]);
    const first = analyze(input);
    write('a.ts', text);
    const next = analyze(input, first.cache);
    expect(next.cache.metrics.hashes).toBeGreaterThan(0);
    expect(next.cache.metrics.factQueries).toBe(0);
    expectCold(next, input);
  });

  it('blocks native reuse when query coverage is unknown', () => {
    const { file, write } = fixture();
    write('a.ts', "import './missing'; export {};");
    const input = project(file('tsconfig.json'), [file('a.ts')]);
    const first = analyze(input);
    for (const importer of Object.values(first.cache.importers))
      importer.coverage = 'unknown';
    const next = analyze(input, first.cache);
    expect(next.cache.metrics.factQueries).toBe(1);
    expectCold(next, input);
  });

  it('rejects a late observed version after a consumer used the old input', () => {
    const { file, write } = fixture();
    write('a.ts', 'export {};');
    const cache = new NativeAnalysisCache('fixture');
    const dependency = cache.inputs.observe(file('a.ts'), 'content');
    cache.inputs.consume([dependency]);
    write('a.ts', 'export const next = 1;');
    expect(() =>
      cache.inputs.observeText({
        path: file('a.ts'),
        text: 'export const next = 1;',
        checkedAt: Date.now(),
        beforeMtime: statSync(file('a.ts')).mtimeMs,
      }),
    ).toThrow(AnalysisInputDriftError);
    expect(dependency.expectedVersion).toBe(
      cache.inputs.records[dependency.inputId].version,
    );
  });

  it('reuses unrelated importer facts through change, undo and change again', () => {
    const { file, write } = fixture();
    write('a.ts', "import { x } from './value'; export const a = x;");
    write('b.ts', "import { x } from './value'; export const b = x;");
    write('value.ts', 'export const x = 1;');
    const input = project(
      file('tsconfig.json'),
      ['a.ts', 'b.ts', 'value.ts'].map((name) => file(name)),
    );
    let result = analyze(input);
    result = analyze(input, result.cache);
    expect(result.cache.metrics.factQueries).toBe(0);
    expect(result.cache.metrics.resolverCalls).toBe(0);
    for (const value of [2, 1, 3]) {
      write(
        'b.ts',
        `import { x } from './value'; export const b = x + ${value};`,
      );
      result = analyze(input, result.cache);
      expectCold(result, input);
      expect(result.cache.metrics.factHits).toBe(1);
      expect(result.cache.metrics.factQueries).toBe(1);
    }
  });

  it('detects old-mtime failed candidates and replaces their observations across deletion', () => {
    const { file, write } = fixture();
    write('a.ts', "import { x } from './foo'; export { x };");
    write('foo/index.ts', 'export const x = 1;');
    const input = project(
      file('tsconfig.json'),
      ['a.ts', 'foo/index.ts'].map((name) => file(name)),
    );
    let result = analyze(input);
    write('foo.ts', 'export const x = 2;');
    utimesSync(file('foo.ts'), 1, 1);
    result = analyze(input, result.cache);
    expectCold(result, input);
    expect(result.facts[0]!.fact.resolution.target?.resolvedFileName).toBe(
      file('foo.ts'),
    );
    rmSync(file('foo.ts'));
    result = analyze(input, result.cache);
    expectCold(result, input);
    expect(result.facts[0]!.fact.resolution.target?.resolvedFileName).toBe(
      file('foo/index.ts'),
    );
  });

  it('withdraws and restores non-root ambient contributors when their only reference changes', () => {
    const { file, write } = fixture();
    write('a.ts', '/// <reference path="./ambient.d.ts" />\nexport {};');
    write('b.ts', "import { x } from 'ambient-only'; export { x };");
    write(
      'ambient.d.ts',
      "declare module 'ambient-only' { export const x: number; }",
    );
    const input = project(
      file('tsconfig.json'),
      ['a.ts', 'b.ts'].map((name) => file(name)),
    );
    let result = analyze(input);
    expect(result.members).toContain(file('ambient.d.ts'));
    expect(
      result.facts.find(({ record }) => record.filePath === file('b.ts'))!.fact
        .typeEvidence.kind,
    ).toBe('ambient');
    write('a.ts', 'export {};');
    result = analyze(input, result.cache);
    expectCold(result, input);
    expect(result.members).not.toContain(file('ambient.d.ts'));
    expect(result.facts[0]!.fact.typeEvidence.kind).toBe('missing');
    write('a.ts', '/// <reference path="./ambient.d.ts" />\nexport {};');
    result = analyze(input, result.cache);
    expectCold(result, input);
    expect(result.members).toContain(file('ambient.d.ts'));
    expect(
      result.facts.find(({ record }) => record.filePath === file('b.ts'))!.fact
        .typeEvidence.kind,
    ).toBe('ambient');
  });
});

describe('manifest and Program environment transitions', () => {
  it('limits existing exports changes to consumers, including an earlier blocked request', () => {
    const { file, write } = fixture();
    write('a.ts', "import {x} from 'pkg/feature'; export {x};");
    write('b.ts', "import {y} from './local'; export {y};");
    write('local.ts', 'export const y = 1;');
    write('node_modules/pkg/value.d.ts', 'export declare const x: number;');
    const input = project(file('tsconfig.json'), [file('a.ts'), file('b.ts')]);
    const manifest = (exports: unknown) =>
      JSON.stringify({ name: 'pkg', exports });
    write(
      'node_modules/pkg/package.json',
      manifest({ './other': './value.d.ts' }),
    );
    let result = analyze(input);
    for (const exports of [
      { './feature': './value.d.ts' },
      { './feature': null },
      { './feature': './value.d.ts' },
    ]) {
      write('node_modules/pkg/package.json', manifest(exports));
      result = analyze(input, result.cache);
      expectCold(result, input);
      expect(result.cache.metrics.factQueries).toBe(1);
      expect(result.cache.metrics.factHits).toBe(1);
    }
    write(
      'node_modules/pkg/package.json',
      JSON.stringify({
        name: 'pkg',
        type: 'module',
        exports: { './feature': './value.d.ts' },
      }),
    );
    result = analyze(input, result.cache);
    expectCold(result, input);
    expect(result.cache.metrics.factHits).toBe(0);
  });

  it('distinguishes absent, null and condition order while ignoring formatting', () => {
    const { file, write } = fixture();
    write('a.ts', "import {x} from 'pkg'; export {x};");
    write('node_modules/pkg/one.d.ts', 'export declare const x: number;');
    write('node_modules/pkg/two.d.ts', 'export declare const x: string;');
    const input = project(file('tsconfig.json'), [file('a.ts')]);
    write(
      'node_modules/pkg/package.json',
      '{"exports":{"import":"./one.d.ts","default":"./two.d.ts"}}',
    );
    let result = analyze(input);
    write(
      'node_modules/pkg/package.json',
      '{ "exports": { "import": "./one.d.ts", "default": "./two.d.ts" } }',
    );
    result = analyze(input, result.cache);
    expect(result.cache.metrics.factQueries).toBe(0);
    write(
      'node_modules/pkg/package.json',
      '{"exports":{"default":"./two.d.ts","import":"./one.d.ts"}}',
    );
    result = analyze(input, result.cache);
    expectCold(result, input);
    expect(result.facts[0]!.fact.resolution.target?.resolvedFileName).toBe(
      file('node_modules/pkg/two.d.ts'),
    );
    for (const manifest of [
      '{}',
      '{"exports":null}',
      '{"exports":"./one.d.ts"}',
    ]) {
      write('node_modules/pkg/package.json', manifest);
      result = analyze(input, result.cache);
      expectCold(result, input);
      expect(result.cache.metrics.factHits).toBe(0);
    }
  });

  it('retains alternative ambient paths and removes an unreachable cycle before reuse', () => {
    const { file, write } = fixture();
    const reference = '/// <reference path="./env.d.ts" />\nexport {};';
    write('a.ts', reference);
    write('b.ts', reference);
    write('use.ts', "import {x} from 'environment'; export {x};");
    write(
      'env.d.ts',
      '/// <reference path="./cycle.d.ts" />\ndeclare module "environment" { export const x: number; }',
    );
    write('cycle.d.ts', '/// <reference path="./env.d.ts" />\n');
    const input = project(file('tsconfig.json'), [
      file('a.ts'),
      file('b.ts'),
      file('use.ts'),
    ]);
    let result = analyze(input);
    for (const [source, text, present] of [
      ['a.ts', 'export {};', true],
      ['b.ts', 'export {};', false],
      ['a.ts', reference, true],
    ] as const) {
      write(source, text);
      result = analyze(input, result.cache);
      expectCold(result, input);
      expect(result.members.includes(file('env.d.ts'))).toBe(present);
      expect(result.members.includes(file('cycle.d.ts'))).toBe(present);
    }
  });

  it('does not mechanically invalidate existing importers when an unrelated root is added', () => {
    const { file, write } = fixture();
    write('a.ts', "import {x} from './value'; export {x};");
    write('value.ts', 'export const x = 1;');
    const input = project(file('tsconfig.json'), [
      file('a.ts'),
      file('value.ts'),
    ]);
    const first = analyze(input);
    write('new.ts', 'export const unrelated = 1;');
    const nextInput = project(file('tsconfig.json'), [
      ...input.fileNames,
      file('new.ts'),
    ]);
    const next = analyze(nextInput, first.cache);
    expectCold(next, nextInput);
    expect(next.cache.metrics.factQueries).toBe(0);
  });
});

function diskSnapshot(cache: NativeAnalysisCache): unknown {
  const encoded = JSON.stringify(cache.snapshot());
  return JSON.parse(encoded);
}

it.each(['types', 'jsx', 'import-mode', 'reference-types'] as const)(
  'reuses and invalidates native %s observations',
  (channel) => {
    const { file, write } = fixture();
    write(
      'node_modules/@types/environment/package.json',
      '{"name":"@types/environment","types":"index.d.ts"}',
    );
    write(
      'node_modules/@types/environment/index.d.ts',
      'declare module "configured-env" {export const x:number;}',
    );
    write(
      'runtime/jsx-runtime.ts',
      'export namespace JSX {export interface IntrinsicElements {div:{}}}',
    );
    write('dep.ts', 'export const x = 1;');
    const source = channel === 'jsx' ? 'a.tsx' : 'a.ts';
    const contents = {
      types: 'import {x} from "configured-env"; export {x};',
      jsx: 'export const element = <div/>;',
      'import-mode':
        'import type {x} from "./dep" with { "resolution-mode":"import" }; export type X = typeof x;',
      'reference-types':
        '/// <reference types="environment" />\nimport {x} from "configured-env"; export {x};',
    };
    write(source, contents[channel]);
    const input = project(file('tsconfig.json'), [file(source)]);
    input.options = {
      ...input.options,
      types: channel === 'types' ? ['environment'] : [],
      jsx: ts.JsxEmit.ReactJSX,
      jsxImportSource: './runtime',
    };
    let result = analyze(input);
    result = analyze(input, result.cache);
    expectCold(result, input);
    expect(result.cache.metrics.factQueries).toBe(0);
    expect(result.cache.metrics.factHits).toBeGreaterThan(0);
    write(source, `${contents[channel]}\nexport const changed = 1;`);
    result = analyze(input, result.cache);
    expectCold(result, input);
    expect(result.cache.metrics.factQueries).toBeGreaterThan(0);
  },
);

it('deduplicates queries without losing identical occurrences', () => {
  const { file, write } = fixture();
  write('a.ts', 'import "./value"; import "./value"; export {};');
  write('value.ts', 'export {};');
  const input = project(file('tsconfig.json'), [file('a.ts')]);
  const first = analyze(input);
  expect(first.facts).toHaveLength(2);
  const queryCount = Object.keys(first.cache.queries).length;
  const next = analyze(input, first.cache);
  expectCold(next, input);
  expect(next.cache.metrics.factHits).toBe(2);
  expect(Object.keys(next.cache.queries)).toHaveLength(queryCount);
  write('a.ts', 'import "./value"; export {};');
  const removed = analyze(input, next.cache);
  expectCold(removed, input);
  expect(removed.facts).toHaveLength(1);
});

it('invalidates redirected declaration providers through removal and restoration', () => {
  const { file, write } = fixture();
  write('a.ts', 'import {x} from "./dep/src/value"; export {x};');
  write('dep/src/value.ts', 'export const x=1;');
  write(
    'dep/tsconfig.json',
    JSON.stringify({
      compilerOptions: {
        composite: true,
        declaration: true,
        rootDir: 'src',
        outDir: 'lib',
      },
      files: ['src/value.ts'],
    }),
  );
  write('dep/lib/value.d.ts', 'export declare const x:number;');
  const input = {
    ...project(file('tsconfig.json'), [file('a.ts')]),
    projectReferences: [{ path: file('dep/tsconfig.json') }],
  };
  let result = analyze(input);
  expect(result.facts[0]!.fact.typeEvidence.kind).toBe('concrete-declaration');
  result = analyze(input, result.cache);
  expect(result.cache.metrics.factQueries).toBe(0);
  for (const isPresent of [false, true, false]) {
    if (isPresent)
      write('dep/lib/value.d.ts', 'export declare const x:number;');
    else rmSync(file('dep/lib/value.d.ts'));
    result = analyze(input, result.cache);
    expectCold(result, input);
    expect(result.facts[0]!.fact.typeEvidence.kind).toBe(
      isPresent ? 'concrete-declaration' : 'missing',
    );
  }
});

it('tracks imports aliases, self-name exports and direct JSON consumers separately', () => {
  const { file, write } = fixture();
  write('a.ts', 'import {x} from "#alias"; export {x};');
  write('b.ts', 'import {x} from "self/feature"; export {x};');
  write('json.ts', 'import manifest from "./package.json"; export {manifest};');
  write('one.ts', 'export const x=1;');
  write('two.ts', 'export const x=2;');
  write(
    'node_modules/pkg/package.json',
    '{"name":"pkg","exports":"./index.d.ts"}',
  );
  write('node_modules/pkg/index.d.ts', 'export declare const x:number;');
  const input = project(
    file('tsconfig.json'),
    ['a.ts', 'b.ts', 'json.ts'].map((name) => file(name)),
  );
  input.options.resolveJsonModule = true;
  const manifest = (target: string) =>
    JSON.stringify({
      name: 'self',
      imports: { '#alias': target },
      exports: { './feature': './one.ts' },
    });
  write('package.json', manifest('./one.ts'));
  let result = analyze(input);
  for (const target of ['./two.ts', 'pkg', './missing.ts', './one.ts']) {
    write('package.json', manifest(target));
    result = analyze(input, result.cache);
    expectCold(result, input);
    expect(result.cache.metrics.factQueries).toBeGreaterThan(0);
  }
});

it('invalidates a whole domain when manifest consumer metadata is incomplete', () => {
  const { file, write } = fixture();
  write('a.ts', 'import "pkg"; export {};');
  write('b.ts', 'import "./local"; export {};');
  write('local.ts', 'export {};');
  write('node_modules/pkg/package.json', '{"exports":"./one.d.ts"}');
  write('node_modules/pkg/one.d.ts', 'export {};');
  write('node_modules/pkg/two.d.ts', 'export {};');
  const input = project(file('tsconfig.json'), [file('a.ts'), file('b.ts')]);
  const first = analyze(input);
  const query = Object.values(first.cache.queries).find((query) =>
    query.dependencies.some((dependency) =>
      dependency.inputId.includes('exports'),
    ),
  )!;
  query.coverage = 'unknown';
  write('node_modules/pkg/package.json', '{"exports":"./two.d.ts"}');
  const next = analyze(input, first.cache);
  expectCold(next, input);
  expect(next.cache.metrics.factHits).toBe(0);
});

it('compares augmentation membership and environment order before reusing facts', () => {
  const { file, write } = fixture();
  write('a.ts', 'import {x} from "./value"; export {x};');
  write('value.ts', 'export const x=1;');
  write(
    'one.d.ts',
    'export {}; declare global { interface Window {one:number;} }',
  );
  write('two.d.ts', 'export as namespace Shared; export const shared:number;');
  const references = (names: string[]) =>
    `${names
      .map((name) => `/// <reference path="./${name}" />`)
      .join('\n')}\nexport {};`;
  write('loader.ts', references(['one.d.ts', 'two.d.ts']));
  const input = project(file('tsconfig.json'), [
    file('a.ts'),
    file('loader.ts'),
  ]);
  let result = analyze(input);
  for (const names of [
    ['two.d.ts', 'one.d.ts'],
    ['two.d.ts'],
    ['one.d.ts', 'two.d.ts'],
  ]) {
    write('loader.ts', references(names));
    result = analyze(input, result.cache);
    expectCold(result, input);
    expect(result.cache.metrics.factHits).toBe(0);
    expect(Object.values(result.cache.projects)[0]!.environment).toEqual(
      names.map((name) => file(name)),
    );
  }
});

it('keeps per-input timestamp checkpoints and reconciles text actually read by the Program', () => {
  const { file, write } = fixture();
  write('a.ts', 'import "./value"; export {};');
  write('value.ts', 'export {};');
  const input = project(file('tsconfig.json'), [file('a.ts')]);
  const first = analyze(input);
  const contentId = JSON.stringify(['physical', 'content', file('a.ts')]);
  const checkpoint = first.cache.inputs.records[contentId]!;
  const oldTime = statSync(file('a.ts')).mtime;
  write('a.ts', 'import "./missing"; export {};');
  utimesSync(file('a.ts'), oldTime, oldTime);
  const trusted = new NativeAnalysisCache(
    'fixture',
    parseAnalysisSnapshot(diskSnapshot(first.cache), 'fixture'),
  );
  expect(trusted.inputs.observe(file('a.ts'), 'content').expectedVersion).toBe(
    checkpoint.version,
  );
  expect(trusted.inputs.records[contentId]!.verifiedThrough).toBe(
    checkpoint.verifiedThrough,
  );
  // The timestamp fast path trusts the old version, but an actual compiler read
  // supersedes it. A cold invocation also observes the new unresolved import.
  const next = analyze(input, first.cache);
  expectCold(next, input);
  expect(next.facts[0]!.record.specifier).toBe('./missing');
  expect(next.cache.metrics.factQueries).toBe(1);
});

it.each(['a.ts', 'virtual.json'])(
  'does not persist facts for virtual input %s',
  (virtual) => {
    const { file, write } = fixture();
    write('a.ts', 'import "./value"; export {};');
    write('value.ts', 'export {};');
    const input = {
      ...project(file('tsconfig.json'), [file('a.ts')]),
      virtualFiles: new Map([[file(virtual), 'import "./value"; export {};']]),
    };
    const result = analyze(input);
    expect(result.cache.metrics.fallbacks).toBeGreaterThan(0);
    expect(Object.keys(result.cache.importers)).toHaveLength(0);
    const next = analyze(input, result.cache);
    expectCold(next, input);
    expect(next.cache.metrics.factHits).toBe(0);
  },
);

it('replaces occurrence contributions without duplicates or partial failed transactions', () => {
  const { file, write } = fixture();
  write('a.ts', 'import "./value"; import "./value"; export {};');
  write('value.ts', 'export {};');
  const result = analyze(project(file('tsconfig.json'), [file('a.ts')]));
  const ledger = result.cache.contributions;
  const contributions = result.facts.map(({ record }) => ({
    occurrence: record,
    fromConfigPath: file('tsconfig.json'),
    toConfigPath: file('dep/tsconfig.json'),
    fromChecker: 'tsc',
    toChecker: 'tsc',
    kind: 'declaration-provider',
  }));
  const replace = (items: typeof contributions, isComplete = true) =>
    ledger.replaceProject({
      config: file('tsconfig.json'),
      checker: 'tsc',
      complete: isComplete,
      collect: () => {
        for (const item of items) ledger.record(item);
      },
    });
  replace(contributions);
  expect(ledger.counts().values().toArray()).toEqual([2]);
  replace([...contributions, ...contributions]);
  expect(ledger.counts().values().toArray()).toEqual([2]);
  replace([], false);
  expect(ledger.counts().values().toArray()).toEqual([2]);
  replace(contributions.slice(1));
  expect(ledger.counts().values().toArray()).toEqual([1]);
  replace([]);
  expect(ledger.counts().size).toBe(0);
});

it('uses domain invalidation when a previously missing package manifest appears or disappears', () => {
  const { file, write } = fixture();
  write('a.ts', 'import {x} from "pkg"; export {x};');
  write('b.ts', 'import "./local"; export {};');
  write('local.ts', 'export {};');
  write('node_modules/pkg/index.d.ts', 'export declare const x:number;');
  const input = project(file('tsconfig.json'), [file('a.ts'), file('b.ts')]);
  let result = analyze(input);
  for (const isPresent of [true, false, true]) {
    if (isPresent)
      write(
        'node_modules/pkg/package.json',
        '{"name":"pkg","exports":"./index.d.ts"}',
      );
    else rmSync(file('node_modules/pkg/package.json'));
    result = analyze(input, result.cache);
    expectCold(result, input);
    expect(result.cache.metrics.factHits).toBe(0);
    expect(result.cache.inputs.domainDirty).toBe(true);
  }
});

it('validates structural transitions even at a zero content timestamp', () => {
  const { file, write } = fixture();
  const cache = new NativeAnalysisCache('fixture');
  const missing = cache.inputs.observe(file('candidate'), 'content');
  mkdirSync(file('directory'));
  const directory = cache.inputs.observe(file('directory'), 'entries');
  write('candidate', 'export {};');
  utimesSync(file('candidate'), 0, 0);
  rmSync(file('directory'), { recursive: true });
  write('directory', 'replacement file');
  const next = new AnalysisInputs(
    cache.inputs.records,
    new NativeAnalysisCache('fixture').metrics,
  );
  expect(next.observe(file('candidate'), 'content').expectedVersion).not.toBe(
    missing.expectedVersion,
  );
  expect(next.observe(file('directory'), 'entries').expectedVersion).not.toBe(
    directory.expectedVersion,
  );
});
