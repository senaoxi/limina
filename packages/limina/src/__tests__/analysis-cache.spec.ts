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
import { cloneAnalysisSnapshot } from '../core/analysis-cache/snapshot-receipts';
import { parseAnalysisSnapshot } from '../core/analysis-cache/snapshot-schema';
import { collectSourceConfigCoverage } from '../core/build-graph/source-config-coverage';
import { createImportAnalysisContext } from '../core/import-analysis/runner';
import { createProjectDependencyCaches } from '../core/project-dependencies/cache';
import { collectProjectDependencies } from '../core/project-dependencies/provider';
import { createTypeScriptDependencyContext } from '../core/typescript-semantic';
import type { TypeScriptSemanticProject } from '../core/typescript-semantic/contracts';
import type { NativeDependencyFact } from '../core/typescript-semantic/dependency-fact';
import { createWorkspaceSourceBoundary } from '../core/typescript-semantic/workspace-source-boundary';
import {
  readStoredAnalysisSnapshot,
  writeStoredAnalysisSnapshot,
} from './helpers/analysis-snapshot';
import { createFixturePathResolver } from './helpers/path';

const fixtures: string[] = [];
afterEach(() => {
  for (const root of fixtures.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const temporary = mkdtempSync(path.join(tmpdir(), 'limina-analysis-cache-'));
  const root = realpathSync.native(temporary);
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
  const cache = new NativeAnalysisCache('fixture', snapshot, 'fixture-config');
  const bounded = withCoverage(project);
  const context =
    cache.restoreContext(bounded) ??
    createTypeScriptDependencyContext(bounded, { analysisCache: cache });
  const facts = project.fileNames.flatMap((file) =>
    context
      .getImportRecords(file)
      .map((record) => ({ record, fact: context.getDependencyFact(record) })),
  );
  const members = context.getContributionFileNames!();
  const evidence = context.nativeEvidence!;
  expect(evidence.failures).toEqual([]);
  if ('dispose' in context && typeof context.dispose === 'function')
    context.dispose();
  return { cache, facts, members, evidence };
}

// This fixture's selected U contains its actual source config. Members come
// from TypeScript config parsing, independently of the tested consumer roots.
function withCoverage(
  input: TypeScriptSemanticProject,
): TypeScriptSemanticProject {
  const coverage = collectSourceConfigCoverage({
    universe: {
      id: 'fixture',
      revision: 'fixture',
      scopeFingerprint: 'fixture',
      inputVersion: 'fixture',
      selectionEvidenceId: 'fixture-selected-config',
      sourceConfigIds: [input.configPath],
      discovery: 'closed',
    },
    parse: (config) =>
      ts.getParsedCommandLineOfConfigFile(
        config,
        {},
        {
          ...ts.sys,
          onUnRecoverableConfigFileDiagnostic: (error) => {
            throw new Error(String(error.messageText));
          },
        },
      ),
  });
  return {
    ...input,
    admissionMode: 'coverage-bounded',
    workspaceSourceBoundary: createWorkspaceSourceBoundary(
      input.fileNames,
      undefined,
      coverage,
    ),
  };
}

// Compare meaning across independently collected contexts. Exact identities
// are asserted separately for restore, phase changes and source invalidation.
function factMeaning(fact: NativeDependencyFact) {
  const evidence = fact.nativeEvidence!;
  const obligation = evidence.obligation;
  const { identity: _identity, ...resolution } = fact.resolution;
  return {
    resolution,
    admission: fact.admission,
    redirect: fact.redirect,
    referenceRequirement: fact.referenceRequirement,
    coverage: evidence.coverage,
    inputs: evidence.origin.context.inputs,
    authority: evidence.origin.context.authority,
    obligation:
      obligation === null
        ? null
        : {
            target: obligation.targetConfigId,
            existence: obligation.existence.state,
            rule:
              obligation.existence.state === 'unknown'
                ? obligation.existence.gapIds.map((id) =>
                    id === evidence.requestId ? 'request' : id,
                  )
                : obligation.existence.proof.ruleOrObservation,
            structure: obligation.structure.state,
            artifact: obligation.artifact.state,
          },
  };
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
  expect(
    result.facts.map(({ record, fact }) => ({
      record,
      fact: factMeaning(fact),
    })),
  ).toEqual(
    cold.facts.map(({ record, fact }) => ({ record, fact: factMeaning(fact) })),
  );
  expect(result.members).toEqual(cold.members);
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
        caches: createProjectDependencyCaches(cache),
        importAnalysis: createImportAnalysisContext(),
      });
    let cache = new NativeAnalysisCache('fixture', undefined, 'fixture-config');
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
        'fixture-config',
      );
      result = collect(cache);
      const cold = collect(
        new NativeAnalysisCache('fixture', undefined, 'fixture-config'),
      );
      expect(result.observations.map((item) => item.evidence.runtime)).toEqual(
        cold.observations.map((item) => item.evidence.runtime),
      );
      expect(
        result.dependencies.map((item) => factMeaning(item.nativeFact!)),
      ).toEqual(cold.dependencies.map((item) => factMeaning(item.nativeFact!)));
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
    expect(next.cache.invalidation.inputQueries.size).toBe(0);
    expect(next.cache.invalidation.queryImporters.size).toBe(0);
    expect(next.cache.invalidation.semanticConsumers.size).toBe(0);
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
    expect(next.cache.metrics.semanticPrograms).toBe(1);
    expectCold(next, input);
  });

  it('rejects a late observed version after a consumer used the old input', () => {
    const { file, write } = fixture();
    write('a.ts', 'export {};');
    const cache = new NativeAnalysisCache(
      'fixture',
      undefined,
      'fixture-config',
    );
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

  it('restores a context and reacquires facts through change, undo and change again', () => {
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
      expect(result.cache.metrics.restoredContexts ?? 0).toBe(0);
      expect(result.cache.metrics.semanticPrograms).toBe(1);
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
    expect(result.cache.metrics.semanticPrograms).toBe(1);
    expect(result.cache.metrics.restoredContexts ?? 0).toBe(0);
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

  it('withdraws and restores incoming requests without loading a foreign ambient declaration', () => {
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
    expect(result.members).not.toContain(file('ambient.d.ts'));
    expect(
      result.evidence.requests.some(
        (request) => request.specifier === './ambient.d.ts',
      ),
    ).toBe(true);
    expect(
      result.facts.find(({ record }) => record.filePath === file('b.ts'))!.fact
        .resolution.target,
    ).toBeNull();
    write('a.ts', 'export {};');
    result = analyze(input, result.cache);
    expectCold(result, input);
    expect(result.members).not.toContain(file('ambient.d.ts'));
    expect(result.facts[0]!.fact.resolution.target).toBeNull();
    write('a.ts', '/// <reference path="./ambient.d.ts" />\nexport {};');
    result = analyze(input, result.cache);
    expectCold(result, input);
    expect(result.members).not.toContain(file('ambient.d.ts'));
    expect(
      result.evidence.requests.some(
        (request) => request.specifier === './ambient.d.ts',
      ),
    ).toBe(true);
    expect(
      result.facts.find(({ record }) => record.filePath === file('b.ts'))!.fact
        .resolution.target,
    ).toBeNull();
  });
});

describe('manifest and Program environment transitions', () => {
  it('reacquires exports consumers, including an earlier blocked request', () => {
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
      expect(result.cache.metrics.semanticPrograms).toBe(1);
      expect(result.cache.metrics.restoredContexts ?? 0).toBe(0);
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
    expect(result.facts[0]!.fact.resolution.target?.resolvedFileName).toBe(
      file('node_modules/pkg/one.d.ts'),
    );
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

  it('retains alternative incoming paths without entering a foreign declaration cycle', () => {
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
      expect(result.members).not.toContain(file('env.d.ts'));
      expect(
        result.evidence.requests.some(
          (request) => request.specifier === './env.d.ts',
        ),
      ).toBe(present);
      expect(result.members).not.toContain(file('cycle.d.ts'));
    }
  });

  it('reacquires the new root context without changing existing dependency meaning', () => {
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
      'package.json',
      '{"name":"native-cache-fixture","private":true,"packageManager":"npm@11.6.1","devDependencies":{"@types/environment":"1.0.0"}}',
    );
    write(
      'package-lock.json',
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': { devDependencies: { '@types/environment': '1.0.0' } },
          'node_modules/@types/environment': { version: '1.0.0' },
        },
      }),
    );
    write(
      'node_modules/@types/environment/package.json',
      '{"name":"@types/environment","version":"1.0.0","types":"index.d.ts"}',
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
    expect(result.cache.metrics.restoredContexts).toBe(1);
    expect(result.cache.metrics.semanticPrograms).toBe(0);
    write(source, `${contents[channel]}\nexport const changed = 1;`);
    result = analyze(input, result.cache);
    expectCold(result, input);
    expect(result.cache.metrics.semanticPrograms).toBe(1);
  },
);

it('restores duplicate occurrences and removes a deleted occurrence', () => {
  const { file, write } = fixture();
  write('a.ts', 'import "./value"; import "./value"; export {};');
  write('value.ts', 'export {};');
  const input = project(file('tsconfig.json'), [file('a.ts')]);
  const first = analyze(input);
  expect(first.facts).toHaveLength(2);
  const queryCount = Object.keys(first.cache.queries).length;
  const next = analyze(input, first.cache);
  expectCold(next, input);
  expect(next.cache.metrics.restoredContexts).toBe(1);
  expect(next.evidence).toEqual(first.evidence);
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
  expect(result.facts[0]!.fact.redirect).toMatchObject({
    originalTarget: file('dep/src/value.ts'),
    declarationTarget: file('dep/lib/value.d.ts'),
    availability: 'present',
  });
  result = analyze(input, result.cache);
  expect(result.cache.metrics.factQueries).toBe(0);
  for (const isPresent of [false, true, false]) {
    if (isPresent)
      write('dep/lib/value.d.ts', 'export declare const x:number;');
    else rmSync(file('dep/lib/value.d.ts'));
    result = analyze(input, result.cache);
    expectCold(result, input);
    expect(result.facts[0]!.fact.redirect?.availability).toBe(
      isPresent ? 'present' : 'missing',
    );
    expect(result.facts[0]!.fact.referenceRequirement).toBeNull();
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
    expect(result.cache.metrics.semanticPrograms).toBe(1);
  }
});

it('rejects context restoration when the completeness proof is absent', () => {
  const { file, write } = fixture();
  write('a.ts', 'import "pkg"; export {};');
  write('b.ts', 'import "./local"; export {};');
  write('local.ts', 'export {};');
  write('node_modules/pkg/package.json', '{"exports":"./one.d.ts"}');
  write('node_modules/pkg/one.d.ts', 'export {};');
  write('node_modules/pkg/two.d.ts', 'export {};');
  const input = project(file('tsconfig.json'), [file('a.ts'), file('b.ts')]);
  const first = analyze(input);
  Object.values(first.cache.contexts)[0]!.complete = false;
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
  let input = project(file('tsconfig.json'), [
    file('a.ts'),
    file('loader.ts'),
    file('one.d.ts'),
    file('two.d.ts'),
  ]);
  let result = analyze(input);
  for (const names of [
    ['two.d.ts', 'one.d.ts'],
    ['two.d.ts'],
    ['one.d.ts', 'two.d.ts'],
  ]) {
    write('loader.ts', references(names));
    input = project(
      file('tsconfig.json'),
      ['a.ts', 'loader.ts', ...names].map((name) => file(name)),
    );
    result = analyze(input, result.cache);
    expectCold(result, input);
    expect(result.cache.metrics.factHits).toBe(0);
    expect(result.members.filter((name) => name.endsWith('.d.ts'))).toEqual(
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
    'fixture-config',
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
  expect(next.cache.metrics.semanticPrograms).toBe(1);
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

it('reacquires context when a previously missing package manifest appears or disappears', () => {
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
    expect(result.cache.metrics.semanticPrograms).toBe(1);
  }
});

it('validates structural transitions even at a zero content timestamp', () => {
  const { file, write } = fixture();
  const cache = new NativeAnalysisCache('fixture', undefined, 'fixture-config');
  const missing = cache.inputs.observe(file('candidate'), 'content');
  mkdirSync(file('directory'));
  const directory = cache.inputs.observe(file('directory'), 'entries');
  write('candidate', 'export {};');
  utimesSync(file('candidate'), 0, 0);
  rmSync(file('directory'), { recursive: true });
  write('directory', 'replacement file');
  const next = new AnalysisInputs(
    cache.inputs.records,
    new NativeAnalysisCache('fixture', undefined, 'fixture-config').metrics,
  );
  expect(next.observe(file('candidate'), 'content').expectedVersion).not.toBe(
    missing.expectedVersion,
  );
  expect(next.observe(file('directory'), 'entries').expectedVersion).not.toBe(
    directory.expectedVersion,
  );
});

it('retains large complete dependency receipts through storage and validation', () => {
  const f = fixture();
  f.write('source.ts', 'export {};');
  const snapshot = analyze(
    project(f.file('tsconfig.json'), [f.file('source.ts')]),
  ).cache.snapshot();
  const importer = Object.values(snapshot.importers)[0]!;
  const receipt = importer.dependencies[0]!;
  importer.dependencies = Array.from({ length: 200_000 }, () => receipt);
  const index = f.file('large.liminainfo');
  writeStoredAnalysisSnapshot(index, snapshot);
  const restored = parseAnalysisSnapshot(
    readStoredAnalysisSnapshot(index),
    'fixture',
  )!;
  expect(restored).toBeDefined();
  expect(
    Object.values(restored.importers)[0]!.dependencies.every(
      (value) =>
        value.inputId === receipt.inputId &&
        value.expectedVersion === receipt.expectedVersion,
    ),
  ).toBe(true);
  expect(
    Object.values(restored.importers)[0]!.dependencies.length,
  ).toBeGreaterThan(0);
});

it('preserves JSON semantics, clone isolation and distinct expected versions through scope storage', () => {
  const f = fixture();
  f.write('source.ts', "import { value } from './value.js'; export { value };");
  f.write('value.ts', 'export const value = 1;');
  const input = project(f.file('tsconfig.json'), [
    f.file('source.ts'),
    f.file('value.ts'),
  ]);
  const snapshot = analyze(input).cache.snapshot();
  // Resolution records remain an independently supported storage contract.
  snapshot.queries.storageFixture = {
    contextId: 'storage-fixture',
    file: f.file('source.ts'),
    request: ['storage'],
    result: {},
    dependencies: [],
    coverage: 'unknown',
  };
  // Large requests must retain the existing JSON treatment of undefined slots.
  (Object.values(snapshot.queries)[0]!.request as unknown[]).push(
    'long-request-boundary'.repeat(100),
    undefined,
  );
  const index = f.file('index.liminainfo');
  writeStoredAnalysisSnapshot(index, snapshot);
  const encoded = readStoredAnalysisSnapshot(index);
  const raw = JSON.stringify(snapshot);
  const expected = parseAnalysisSnapshot(JSON.parse(raw), 'fixture');
  expect(expected).toBeDefined();
  expect(parseAnalysisSnapshot(encoded, 'fixture')).toEqual(expected);
  const request = Object.values(snapshot.queries)[0]!.request as unknown[];
  const nested = { values: ['original', undefined] };
  request.push({
    data: {
      ordered: new Map([
        ['second', nested],
        ['first', nested],
      ]),
      members: new Set(['second', 'first']),
      absent: undefined,
    },
  });
  const cloned = cloneAnalysisSnapshot(snapshot);
  expect(cloned).toEqual(snapshot);
  const clonedRequest = Object.values(cloned.queries)[0]!
    .request as typeof request;
  const clonedValue = clonedRequest.at(-1) as {
    data: {
      ordered: Map<string, typeof nested>;
      members: Set<string>;
      absent?: undefined;
    };
  };
  expect(clonedValue.data.ordered.keys().toArray()).toEqual([
    'second',
    'first',
  ]);
  expect([...clonedValue.data.members]).toEqual(['second', 'first']);
  expect(Object.hasOwn(clonedValue.data, 'absent')).toBe(true);
  clonedValue.data.ordered.get('second')!.values[0] = 'changed-clone';
  expect(nested.values).toEqual(['original', undefined]);
  nested.values.push('changed-original');
  expect(clonedValue.data.ordered.get('first')!.values).toEqual([
    'original',
    undefined,
  ]);
  cloned.header.revision = 'changed-clone';
  cloned.configModules.otherUnknownReasons.push('changed-clone');
  expect(snapshot.header.revision).not.toBe('changed-clone');
  expect(snapshot.configModules.otherUnknownReasons).not.toContain(
    'changed-clone',
  );
  const clonedImporter = Object.values(cloned.importers)[0]!;
  clonedImporter.dependencies[0]!.expectedVersion = 'changed-clone';
  const importer = Object.values(snapshot.importers)[0]!;
  expect(importer.dependencies[0]!.expectedVersion).not.toBe('changed-clone');
  request.pop();
  let getterReads = 0;
  const accessor = Object.defineProperty({}, 'value', {
    enumerable: true,
    get() {
      getterReads++;
      return 'opaque';
    },
  });
  request.push({ data: accessor });
  expect(() => cloneAnalysisSnapshot(snapshot)).toThrow();
  expect(getterReads).toBe(0);
  request.pop();
  importer.dependencies.push({
    ...importer.dependencies[0]!,
    expectedVersion: 'different-version',
  });
  writeStoredAnalysisSnapshot(index, snapshot);
  const conflicting = readStoredAnalysisSnapshot(index);
  expect(parseAnalysisSnapshot(conflicting, 'fixture')).toBeUndefined();
});
