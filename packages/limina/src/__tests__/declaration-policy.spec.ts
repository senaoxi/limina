import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { NativeAnalysisCache } from '../core/analysis-cache/native-cache';
import { parseAnalysisSnapshot } from '../core/analysis-cache/snapshot-schema';
import { createManagedOutputDeclarationLookup } from '../core/import-graph/managed-output-provider';
import {
  createTypeScriptDependencyContext,
  createWorkspaceSourceBoundary,
} from '../core/typescript-semantic';
import type { TypeScriptSemanticProject } from '../core/typescript-semantic/contracts';
import { projectNativeDeclarationClosure } from '../core/typescript-semantic/native-closure';
import {
  getResolutionOrigin,
  resolveModuleWithOrigin,
} from '../core/typescript-semantic/resolution-origin';
import { roundTripAnalysisSnapshot } from './helpers/analysis-snapshot';
import { readFixtureSourceCoverage } from './helpers/native-coverage';
import { createSemanticRepairFixture } from './helpers/semantic-repair';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function fixture() {
  const files = {
    'package.json': JSON.stringify({
      name: '@closure/self',
      type: 'module',
      packageManager: 'npm@11.6.1',
      exports: { '.': './b/index.d.ts' },
      imports: { '#local': './b/index.d.ts', '#public': '@closure/b' },
    }),
    'package-lock.json': JSON.stringify({
      lockfileVersion: 3,
      packages: { '': {} },
    }),
    'tsconfig.json': JSON.stringify({ files: ['a.ts'] }),
    'tsconfig.c.json': JSON.stringify({ files: ['c.ts'] }),
    'tsconfig.d.json': JSON.stringify({ files: ['d.ts'] }),
    'tsconfig.declarations.json': JSON.stringify({
      files: ['b/index.d.ts', 'b/helper.d.ts'],
    }),
    'tsconfig.shared.json': JSON.stringify({ files: ['b/index.d.ts'] }),
    'a.ts': 'export type { Value } from "./b/index";',
    'b/package.json': JSON.stringify({
      name: '@closure/b',
      type: 'module',
      types: './index.d.ts',
    }),
    'b/index.d.ts': 'export type { Value } from "./helper";',
    'b/helper.d.ts': 'export type { Value } from "../c";',
    'c.ts': 'export type { Value } from "./d";',
    'd.ts': 'export type Value = number;',
  };
  const f = await createSemanticRepairFixture(files);
  cleanups.push(f.cleanup);
  mkdirSync(f.path('node_modules/@closure'), { recursive: true });
  symlinkSync(f.path('b'), f.path('node_modules/@closure/b'), 'junction');
  const write = (name: string, text: string) => {
    const file = f.path(name);
    if (!existsSync(file) || readFileSync(file, 'utf8') !== text)
      writeFileSync(file, text);
  };
  const project = (
    input: {
      covered?: boolean;
      roots?: string[];
      options?: ts.CompilerOptions;
      additionalConfigs?: string[];
    } = {},
  ): TypeScriptSemanticProject => {
    const roots = input.roots ?? ['a.ts'];
    write('tsconfig.json', JSON.stringify({ files: roots }));
    const selected = [
      'tsconfig.json',
      'tsconfig.c.json',
      'tsconfig.d.json',
      ...(input.covered === false
        ? []
        : ['tsconfig.declarations.json', 'tsconfig.shared.json']),
      ...(input.additionalConfigs ?? []),
    ].map((name) => f.path(name));
    const coverage = readFixtureSourceCoverage(selected);
    return {
      configPath: f.path('tsconfig.json'),
      fileNames: roots.map((name) => f.path(name)),
      analysisBinding: { phase: 'locked', checker: 'tsc' },
      admissionMode: 'coverage-bounded',
      compilationObligationScope: 'generated-declaration-project-v1',
      options: {
        configFilePath: f.path('tsconfig.json'),
        types: [],
        noLib: true,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        ...input.options,
      },
      workspaceSourceBoundary: createWorkspaceSourceBoundary(
        [],
        undefined,
        coverage,
      ),
    };
  };
  return { ...f, write, project };
}

function collect(
  project: TypeScriptSemanticProject,
  previous?: NativeAnalysisCache,
) {
  const snapshot =
    previous === undefined
      ? undefined
      : parseAnalysisSnapshot(
          roundTripAnalysisSnapshot(previous.snapshot()),
          'policy',
          'config',
        );
  if (previous !== undefined) expect(snapshot).toBeDefined();
  const cache = new NativeAnalysisCache('policy', snapshot, 'config');
  const context =
    cache.restoreContext(project) ??
    createTypeScriptDependencyContext(project, { analysisCache: cache });
  const closure = projectNativeDeclarationClosure(context, project);
  const members = context.getContributionFileNames!();
  const targets = [
    ...new Set(
      closure.requirements.map(({ requirement }) => requirement.targetFileName),
    ),
  ].sort((a, b) => a.localeCompare(b));
  const evidence = context.nativeEvidence!;
  if ('dispose' in context && typeof context.dispose === 'function')
    context.dispose();
  return { cache, closure, members, targets, evidence };
}

describe('Coverage-bounded declaration traversal', () => {
  it.each(
    [false, true].flatMap((covered) =>
      ['local', 'package'].map((route) => ({ covered, route })),
    ),
  )(
    'expands declarations according to Coverage, with covered=$covered and route=$route',
    async ({ covered, route }) => {
      const f = await fixture();
      f.write(
        'a.ts',
        `export type { Value } from ${JSON.stringify(route === 'local' ? './b/index' : '@closure/b')};`,
      );
      const result = collect(f.project({ covered }));
      expect(result.evidence.failures).toEqual([]);
      expect(result.closure.incomplete).toEqual([]);
      expect(result.members.includes(f.path('b/helper.d.ts'))).toBe(covered);
      expect(result.closure.links[0]?.expansion).toBe(covered);
      expect(result.closure.links[0]?.stop).toBe(
        covered ? undefined : 'uncovered',
      );
      expect(result.members).not.toContain(f.path('c.ts'));
      expect(result.members).not.toContain(f.path('d.ts'));
      expect(result.targets).toEqual(
        covered && route === 'local' ? [f.path('c.ts')] : [],
      );
      if (covered)
        expect(
          result.evidence.coverage.find(
            (entry) => entry.target.lexicalPath === f.path('b/index.d.ts'),
          )?.state,
        ).toBe('ambiguous');
    },
  );

  it.each([false, true])(
    'does not let managed output attribution override Coverage: %s',
    async (covered) => {
      const f = await fixture();
      const project = f.project({ covered });
      const lookup = createManagedOutputDeclarationLookup([
        {
          checkerName: 'tsc',
          extensions: ['.ts'],
          sourceConfigPath: f.path('tsconfig.c.json'),
          ownedFileNames: [f.path('c.ts')],
          outputOptions: { rootDir: f.path(), outDir: f.path('b') },
        },
      ]);
      const context = createTypeScriptDependencyContext(project);
      const ordinary = projectNativeDeclarationClosure(context, project);
      expect(projectNativeDeclarationClosure(context, project, lookup)).toEqual(
        ordinary,
      );
      expect(ordinary.links[0]?.expansion).toBe(covered);
      context.dispose();
    },
  );

  it.each(['types', 'typings', 'main', 'index', 'typesVersions', 'exports'])(
    'stops the uncovered %s package declaration without a governance failure',
    async (entry) => {
      const f = await fixture();
      f.write('a.ts', 'export type { Value } from "@closure/b";');
      const manifest: Record<string, unknown> = {
        name: '@closure/b',
        type: 'module',
      };
      if (entry === 'exports')
        manifest.exports = { '.': { types: './index.d.ts' } };
      else if (entry === 'typesVersions')
        manifest.typesVersions = { '*': { '*': ['index.d.ts'] } };
      else if (entry !== 'index') manifest[entry] = './index.d.ts';
      f.write('b/package.json', JSON.stringify(manifest));
      const result = collect(f.project({ covered: false }));
      expect(result.targets).toEqual([]);
      expect(result.closure.links[0]).toMatchObject({
        target: f.path('b/index.d.ts'),
        expansion: false,
        stop: 'uncovered',
      });
      expect(result.evidence.failures).toEqual([]);
    },
  );

  it.each([
    {
      name: 'paths',
      specifier: '@closure/b',
      paths: { '@closure/b': ['./b/index.d.ts'] },
      route: 'local',
    },
    {
      name: 'paths fallback',
      specifier: '@closure/b',
      paths: { '@closure/b': ['./absent.d.ts'] },
      route: 'package',
    },
    { name: 'local imports', specifier: '#local', route: 'local' },
    { name: 'forwarded imports', specifier: '#public', route: 'package' },
    { name: 'self reference', specifier: '@closure/self', route: 'package' },
    {
      name: 'package subpath',
      specifier: '@closure/b/index',
      route: 'package',
    },
  ])(
    'keeps $name resolution provenance separate from declaration Coverage',
    async ({ specifier, paths, route }) => {
      const f = await fixture();
      f.write(
        'a.ts',
        `export type { Value } from ${JSON.stringify(specifier)};`,
      );
      const project = f.project({
        options: { paths, pathsBasePath: f.path() } as ts.CompilerOptions,
      });
      const cache = ts.createModuleResolutionCache(
        f.path(),
        (file) => file,
        project.options,
      );
      const raw = ts.resolveModuleName(
        specifier,
        f.path('a.ts'),
        project.options,
        ts.sys,
        cache,
      ).resolvedModule!;
      expect(getResolutionOrigin(raw)).toBeUndefined();
      for (let index = 0; index < 2; index++) {
        const resolved = resolveModuleWithOrigin(
          ts,
          specifier,
          f.path('a.ts'),
          project.options,
          ts.sys,
          cache,
        ).resolvedModule!;
        expect(getResolutionOrigin(resolved)?.route).toBe(route);
      }
      expect(collect(project).closure.links[0]).toMatchObject({
        target: f.path('b/index.d.ts'),
        expansion: true,
      });
      expect(
        collect(f.project({ covered: false, options: project.options })).closure
          .links[0]?.expansion,
      ).toBe(false);
    },
  );

  it.each([
    'root',
    'types',
    'triple-slash',
    'skipLibCheck',
    'noResolve',
    'augmentation',
  ])(
    'keeps the compiler %s entry and its independent traversal boundary',
    async (kind) => {
      const f = await fixture();
      f.write('a.ts', 'export {};');
      const options: ts.CompilerOptions = {};
      const roots = ['a.ts'];
      if (kind === 'root' || kind === 'noResolve')
        roots.push('b/index.d.ts', 'b/helper.d.ts');
      switch (kind) {
        case 'types': {
          options.types = ['./b/index'];
          break;
        }
        case 'triple-slash': {
          f.write(
            'a.ts',
            '/// <reference path="./b/index.d.ts" />\nexport {};',
          );
          break;
        }
        case 'skipLibCheck': {
          options.skipLibCheck = true;
          f.write('a.ts', 'export type { Value } from "./b/index";');
          break;
        }
        case 'noResolve': {
          options.noResolve = true;
          break;
        }
        case 'augmentation': {
          f.write(
            'a.ts',
            'export {}; declare module "./b/index" { interface Added {} }',
          );
          break;
        }
      }
      const project = f.project({ roots, options });
      const oracle = ts.createProgram({
        rootNames: [...project.fileNames],
        options: project.options,
      });
      expect(oracle.getSourceFile(f.path('b/helper.d.ts')) !== undefined).toBe(
        kind !== 'augmentation',
      );
      const result = collect(project);
      expect(result.closure.incomplete).toEqual([]);
      expect(result.members.includes(f.path('b/helper.d.ts'))).toBe(
        kind !== 'augmentation',
      );
      expect(result.targets).toEqual(
        ['augmentation', 'noResolve'].includes(kind) ? [] : [f.path('c.ts')],
      );
      expect(
        result.closure.entries
          .filter((entry) => entry.kind === 'root')
          .map((entry) => entry.fileName),
      ).toEqual(roots.map((name) => f.path(name)));
    },
  );

  it('retains cycle and diamond predecessors without scanning implementation descendants', async () => {
    const f = await fixture();
    f.write(
      'b/index.d.ts',
      'export type { Value } from "./helper"; export * from "./other";',
    );
    f.write('b/other.d.ts', 'export * from "./helper";');
    f.write(
      'b/helper.d.ts',
      'export type { Value } from "../c"; export * from "./index";',
    );
    f.write(
      'tsconfig.declarations.json',
      JSON.stringify({
        files: ['b/index.d.ts', 'b/helper.d.ts', 'b/other.d.ts'],
      }),
    );
    const result = collect(f.project());
    expect(result.targets).toEqual([f.path('c.ts')]);
    expect(
      result.closure.links.filter(
        (link) => link.target === f.path('b/helper.d.ts'),
      ),
    ).toHaveLength(2);
    expect(result.members).not.toContain(f.path('d.ts'));
    f.write('a.ts', 'export {};');
    const removed = collect(f.project(), result.cache);
    expect(removed.closure.links).toEqual([]);
    expect(removed.members).toEqual([f.path('a.ts')]);
  });

  it('restores the same evidence and revokes declaration expansion when the selected config is removed', async () => {
    const f = await fixture();
    const first = collect(f.project());
    const warm = collect(f.project(), first.cache);
    expect(warm.cache.metrics.restoredContexts).toBe(1);
    expect(warm.evidence).toEqual(first.evidence);
    const removed = collect(f.project({ covered: false }), warm.cache);
    expect(removed.cache.metrics.restoredContexts ?? 0).toBe(0);
    expect(removed.targets).toEqual([]);
    expect(removed.members).not.toContain(f.path('b/index.d.ts'));
  });

  it('revokes manifest and symlink targets instead of inheriting the previous declaration membership', async () => {
    const f = await fixture();
    f.write('a.ts', 'export type { Value } from "@closure/b";');
    const first = collect(f.project());
    f.write('b/alternate.d.ts', 'export type { Value } from "../d";');
    f.write(
      'b/package.json',
      JSON.stringify({ name: '@closure/b', types: './alternate.d.ts' }),
    );
    const changed = collect(f.project(), first.cache);
    expect(changed.closure.links[0]).toMatchObject({
      target: f.path('b/alternate.d.ts'),
      expansion: false,
      stop: 'uncovered',
    });
    mkdirSync(f.path('other'));
    f.write(
      'other/package.json',
      JSON.stringify({ name: '@closure/b', types: './index.d.ts' }),
    );
    f.write('other/index.d.ts', 'export {};');
    rmSync(f.path('node_modules/@closure/b'));
    symlinkSync(f.path('other'), f.path('node_modules/@closure/b'), 'junction');
    const rebound = collect(f.project(), changed.cache);
    expect(rebound.closure.links[0]).toMatchObject({
      target: f.path('other/index.d.ts'),
      expansion: false,
    });
    expect(rebound.evidence.failures).toEqual([]);
  });
});
