import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { NativeAnalysisCache } from '../core/analysis-cache/native-cache';
import { parseAnalysisSnapshot } from '../core/analysis-cache/snapshot-schema';
import { createManagedOutputDeclarationLookup } from '../core/import-graph/managed-output-provider';
import { createTypeScriptDependencyContext } from '../core/typescript-semantic';
import type { TypeScriptSemanticProject } from '../core/typescript-semantic/contracts';
import { projectNativeDeclarationClosure } from '../core/typescript-semantic/native-closure';
import {
  getResolutionOrigin,
  resolveModuleWithOrigin,
} from '../core/typescript-semantic/resolution-origin';
import { createWorkspaceSourceBoundaryFromProjects } from '../core/typescript-semantic/workspace-source-boundary';
import { roundTripAnalysisSnapshot } from './helpers/analysis-snapshot';
import { createFixturePathResolver } from './helpers/path';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const temporary = mkdtempSync(
    path.join(tmpdir(), 'limina-declaration-policy-'),
  );
  const rootDirectory = realpathSync.native(temporary);
  roots.push(rootDirectory);
  const file = createFixturePathResolver(rootDirectory);
  const write = (name: string, text: string) => {
    mkdirSync(path.dirname(file(name)), { recursive: true });
    writeFileSync(file(name), text);
  };
  write(
    'package.json',
    JSON.stringify({
      name: '@closure/self',
      type: 'module',
      exports: { '.': './b/index.d.ts' },
      imports: { '#local': './b/index.d.ts', '#public': '@closure/b' },
    }),
  );
  write('tsconfig.json', '{}');
  write('a.ts', 'export type { Value } from "@closure/b";');
  write(
    'b/package.json',
    JSON.stringify({
      name: '@closure/b',
      type: 'module',
      types: './index.d.ts',
    }),
  );
  write('b/index.d.ts', 'export type { Value } from "./helper";');
  write('b/helper.d.ts', 'export type { Value } from "../c";');
  write('c.ts', 'export type { Value } from "./d";');
  write('d.ts', 'export type Value = number;');
  mkdirSync(file('node_modules/@closure'), { recursive: true });
  symlinkSync(file('b'), file('node_modules/@closure/b'), 'junction');
  const project = (
    isGoverned = false,
    options: ts.CompilerOptions = {},
    fileNames = [file('a.ts')],
  ): TypeScriptSemanticProject => {
    const inputs = [
      { configPath: file('tsconfig.json'), fileNames, packageRootDir: file() },
      {
        configPath: file('tsconfig.c.json'),
        fileNames: [file('c.ts')],
        packageRootDir: file(),
      },
      {
        configPath: file('tsconfig.d.json'),
        fileNames: [file('d.ts')],
        packageRootDir: file(),
      },
      ...(isGoverned
        ? ['b', 'b2'].map((name) => ({
            configPath: file(`tsconfig.${name}.json`),
            fileNames: [file('b/index.d.ts')],
            packageRootDir: file(),
          }))
        : []),
    ];
    return {
      analysisBinding: { phase: 'locked', checker: 'tsc' },
      admissionMode: 'full-program',
      configPath: file('tsconfig.json'),
      fileNames,
      options: {
        types: [],
        noLib: true,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        ...options,
      },
      workspaceSourceBoundary:
        createWorkspaceSourceBoundaryFromProjects(inputs),
    };
  };
  return { file, write, project };
}
function collect(
  project: TypeScriptSemanticProject,
  previous?: NativeAnalysisCache,
) {
  const snapshot = previous
    ? parseAnalysisSnapshot(
        roundTripAnalysisSnapshot(previous.snapshot()),
        'policy',
        'config',
      )
    : undefined;
  if (previous) expect(snapshot).toBeDefined();
  const cache = new NativeAnalysisCache('policy', snapshot, 'config');
  const context =
    cache.restoreContext(project) ??
    createTypeScriptDependencyContext(project, { analysisCache: cache });
  const closure = projectNativeDeclarationClosure(context, project);
  const targets = [
    ...new Set(
      closure.requirements.map(({ requirement }) => requirement.targetFileName),
    ),
  ].sort((left, right) => left.localeCompare(right));
  return { cache, closure, targets };
}

describe('declaration governance policy', () => {
  it.each([false, true])(
    'gates only workspace public entries, with governed=%s',
    (governed) => {
      const f = fixture();
      const result = collect(f.project(governed));
      expect(result.closure.incomplete).toEqual([]);
      expect(result.targets).toEqual(governed ? [f.file('c.ts')] : []);
      expect(result.targets).not.toContain(f.file('d.ts'));
      const c = collect(f.project(false, {}, [f.file('c.ts')]));
      expect(c.targets).toEqual([f.file('d.ts')]);
    },
  );

  it('rejects cached contexts missing type-environment entry evidence', () => {
    const f = fixture();
    f.write('types/env/index.d.ts', 'export type { Value } from "../../c";');
    const result = collect(
      f.project(false, { types: ['env'], typeRoots: [f.file('types')] }),
    );
    const serialized = parseAnalysisSnapshot(
      roundTripAnalysisSnapshot(result.cache.snapshot()),
      'policy',
      'config',
    )!;
    const missingEntries = structuredClone(serialized);
    delete (
      Object.values(missingEntries.contexts)[0] as { typeEntries?: unknown }
    ).typeEntries;
    expect(
      parseAnalysisSnapshot(missingEntries, 'policy', 'config'),
    ).toBeUndefined();
    const missingOrigin = structuredClone(serialized);
    delete Object.values(missingOrigin.contexts)[0]!.typeEntries[0]!.origin;
    expect(
      parseAnalysisSnapshot(missingOrigin, 'policy', 'config'),
    ).toBeUndefined();
  });

  it('preserves a confirmed managed output before declaration membership', () => {
    const f = fixture();
    f.write('producer/index.ts', 'export type Value = number;');
    const project = f.project(true);
    const lookup = createManagedOutputDeclarationLookup([
      {
        checkerName: 'tsc',
        extensions: ['.ts'],
        sourceConfigPath: f.file('producer/tsconfig.json'),
        ownedFileNames: [f.file('producer/index.ts')],
        outputOptions: { rootDir: f.file('producer'), outDir: f.file('b') },
      },
    ]);
    const context = createTypeScriptDependencyContext(project);
    try {
      const closure = projectNativeDeclarationClosure(context, project, lookup);
      expect(closure.links[0]?.stop).toBe('managed-output');
      expect(closure.requirements).toEqual([]);
      expect(closure.incomplete).toEqual([]);
    } finally {
      context.dispose();
    }
  });

  it('keeps the @types fallback public after an unsuccessful package main candidate', () => {
    const f = fixture();
    f.write('a.ts', 'export type { Value } from "third-party";');
    f.write(
      'node_modules/third-party/package.json',
      JSON.stringify({ main: './lib/index.js' }),
    );
    f.write('node_modules/third-party/lib/index.js', 'module.exports = {};');
    f.write(
      'node_modules/@types/third-party/index.d.ts',
      'export type { Value } from "../../../c";',
    );
    const result = collect(f.project());
    expect(result.closure.links[0]?.origin?.route).toBe('package');
    expect(result.targets).toEqual([]);
    expect(result.closure.incomplete).toEqual([]);
  });

  it('keeps the local entry to the same declaration and revokes only its last contribution', () => {
    const f = fixture();
    const publicOnly = collect(f.project());
    f.write(
      'a.ts',
      'export type { Value } from "@closure/b"; export type Local = import("./b/index").Value;',
    );
    const both = collect(f.project(), publicOnly.cache);
    expect(both.targets).toEqual([f.file('c.ts')]);
    expect(
      both.closure.links
        .filter((link) => link.target === f.file('b/index.d.ts'))
        .map((link) => link.expansion),
    ).toEqual([false, true]);
    f.write('a.ts', 'export type { Value } from "@closure/b";');
    const removed = collect(f.project(), both.cache);
    expect(removed.targets).toEqual([]);
    expect(removed.closure.incomplete).toEqual([]);
  });

  it.each([
    {
      name: 'paths',
      specifier: '@closure/b',
      paths: { '@closure/b': ['./b/index.d.ts'] },
      route: 'local',
      expands: true,
    },
    {
      name: 'paths fallback',
      specifier: '@closure/b',
      paths: { '@closure/b': ['./absent.d.ts'] },
      route: 'package',
      expands: false,
    },
    {
      name: 'local imports',
      specifier: '#local',
      route: 'local',
      expands: true,
    },
    {
      name: 'forwarded imports',
      specifier: '#public',
      route: 'package',
      expands: false,
    },
    {
      name: 'self reference',
      specifier: '@closure/self',
      route: 'package',
      expands: false,
    },
    {
      name: 'package subpath',
      specifier: '@closure/b/index',
      route: 'package',
      expands: false,
    },
  ])(
    'uses successful $name evidence, including TypeScript cache hits',
    ({ specifier, paths, route, expands }) => {
      const f = fixture();
      f.write(
        'a.ts',
        `export type { Value } from ${JSON.stringify(specifier)};`,
      );
      const project = f.project(false, {
        paths,
        pathsBasePath: f.file(),
      } as ts.CompilerOptions);
      const cache = ts.createModuleResolutionCache(
        f.file(),
        (file) => file,
        project.options,
      );
      const previouslyResolved = ts.resolveModuleName(
        specifier,
        f.file('a.ts'),
        project.options,
        ts.sys,
        cache,
      ).resolvedModule!;
      expect(getResolutionOrigin(previouslyResolved)).toBeUndefined();
      for (let index = 0; index < 2; index += 1) {
        const resolved = resolveModuleWithOrigin(
          ts,
          specifier,
          f.file('a.ts'),
          project.options,
          ts.sys,
          cache,
        ).resolvedModule;
        expect(resolved).toBeDefined();
        expect(getResolutionOrigin(resolved!)?.route).toBe(route);
        expect(getResolutionOrigin(previouslyResolved)?.route).toBe(route);
      }
      const result = collect(project);
      expect(result.closure.incomplete).toEqual([]);
      expect(result.targets).toEqual(expands ? [f.file('c.ts')] : []);
    },
  );

  it.each(['types', 'typings', 'main', 'index', 'typesVersions', 'exports'])(
    'stops the %s package entry without membership',
    (entry) => {
      const f = fixture();
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
      const result = collect(f.project());
      expect(result.closure.incomplete).toEqual([]);
      expect(result.targets).toEqual([]);
      expect(result.closure.links[0]?.stop).toBe(
        'ungoverned-workspace-public-declaration',
      );
    },
  );

  it('rechecks a nested public entry after entering a local declaration', () => {
    const f = fixture();
    f.write('a.ts', 'export type { Value } from "./local";');
    f.write('local.d.ts', 'export type { Value } from "@closure/b";');
    expect(collect(f.project()).targets).toEqual([]);
    expect(collect(f.project(true)).targets).toEqual([f.file('c.ts')]);
  });

  it.each([
    'root',
    'types',
    'typeRoots',
    'triple-slash',
    'skipLibCheck',
    'noResolve',
    'augmentation',
  ])('respects the independent %s entry contract', (kind) => {
    const f = fixture();
    f.write('a.ts', 'export {};');
    const options: ts.CompilerOptions = {};
    const files = [f.file('a.ts')];
    if (kind === 'root' || kind === 'noResolve')
      files.push(f.file('b/index.d.ts'), f.file('b/helper.d.ts'));
    switch (kind) {
      case 'noResolve': {
        options.noResolve = true;
        break;
      }
      case 'types': {
        options.types = ['./b/index'];
        break;
      }
      case 'typeRoots': {
        options.typeRoots = [f.file('local-types')];
        options.types = ['env'];
        f.write(
          'local-types/env/index.d.ts',
          'export type { Value } from "../../b/index";',
        );

        break;
      }
      case 'triple-slash': {
        f.write('a.ts', '/// <reference path="./b/index.d.ts" />\nexport {};');
        break;
      }
      case 'skipLibCheck': {
        options.skipLibCheck = true;
        f.write('a.ts', 'export type { Value } from "./b/index";');

        break;
      }
      case 'augmentation': {
        f.write(
          'a.ts',
          'export {}; declare module "./b/index" { interface Added {} }',
        );
        // No default
        break;
      }
    }
    const result = collect(f.project(false, options, files));
    expect(result.closure.incomplete).toEqual([]);
    expect(result.targets).toEqual(
      kind === 'augmentation' ? [] : [f.file('c.ts')],
    );
    expect(
      result.closure.entries
        .filter((entry) => entry.kind === 'root')
        .map((entry) => entry.fileName),
    ).toEqual(files);
  });

  it('retains cycle and diamond predecessors without flattening implementation branches', () => {
    const f = fixture();
    f.write('a.ts', 'export type { Value } from "./b/index";');
    f.write(
      'b/index.d.ts',
      'export type { Value } from "./helper"; export * from "./other";',
    );
    f.write(
      'b/other.d.ts',
      'export * from "./helper"; export * from "../extra";',
    );
    f.write(
      'b/helper.d.ts',
      'export type { Value } from "../c"; export * from "./index";',
    );
    f.write('extra.ts', 'export const extra = 1;');
    const result = collect(f.project());
    expect(result.targets).toEqual([f.file('c.ts'), f.file('extra.ts')]);
    expect(
      result.closure.links.filter(
        (link) => link.target === f.file('b/helper.d.ts'),
      ),
    ).toHaveLength(2);
  });

  it('restores facts but recomputes qualification after membership changes', () => {
    const f = fixture();
    const cold = collect(f.project(true));
    const warm = collect(f.project(true), cold.cache);
    expect(warm.cache.metrics.restoredContexts).toBeGreaterThan(0);
    expect(warm.closure).toEqual(cold.closure);
    const removed = collect(f.project(false), warm.cache);
    expect(removed.targets).toEqual([]);
    expect(collect(f.project(true), removed.cache).targets).toEqual([
      f.file('c.ts'),
    ]);
  });
  it('invalidates manifest, symlink and negative lookup receipts', () => {
    const f = fixture();
    const options = {
      paths: { '@closure/b': ['./candidate.d.ts'] },
      pathsBasePath: f.file(),
    } as ts.CompilerOptions;
    const before = collect(f.project(false, options));
    expect(before.targets).toEqual([]);
    f.write('candidate.d.ts', 'export type { Value } from "./c";');
    const candidate = collect(f.project(false, options), before.cache);
    expect(candidate.targets).toEqual([f.file('c.ts')]);
    rmSync(f.file('candidate.d.ts'));
    f.write('b/alternate.d.ts', 'export type { Value } from "../d";');
    f.write(
      'b/package.json',
      JSON.stringify({ name: '@closure/b', types: './alternate.d.ts' }),
    );
    const changed = collect(f.project(true), candidate.cache);
    expect(changed.targets).toEqual([]);
    expect(changed.closure.links[0]?.target).toBe(f.file('b/alternate.d.ts'));
    f.write(
      'b/package.json',
      JSON.stringify({ name: '@closure/b', types: './index.d.ts' }),
    );
    const governed = collect(f.project(true), changed.cache);
    expect(governed.targets).toEqual([f.file('c.ts')]);
    f.write(
      'other/package.json',
      JSON.stringify({ name: '@closure/b', types: './index.d.ts' }),
    );
    f.write('other/index.d.ts', 'export type { Value } from "../d";');
    rmSync(f.file('node_modules/@closure/b'));
    symlinkSync(f.file('other'), f.file('node_modules/@closure/b'), 'junction');
    const rebound = collect(f.project(true), governed.cache);
    expect(rebound.targets).toEqual([]);
    expect(rebound.closure).toEqual(collect(f.project(true)).closure);
  });

  it('keeps shared declaration syntax within each consumer resolution context', () => {
    const f = fixture();
    f.write('a.ts', 'export type { Value } from "./b/index";');
    f.write('b/index.d.ts', 'export type { Value } from "endpoint";');
    const first = f.project(false, { paths: { endpoint: [f.file('c.ts')] } });
    const second = f.project(false, { paths: { endpoint: [f.file('d.ts')] } });
    second.configPath = f.file('tsconfig.other.json');
    const left = collect(first);
    const right = collect(second, left.cache);
    expect(left.targets).toEqual([f.file('c.ts')]);
    expect(right.targets).toEqual([f.file('d.ts')]);
    expect(collect(first, right.cache).targets).toEqual(left.targets);
  });

  it('keeps configured type entries through restoration and removes their last contribution', () => {
    const f = fixture();
    f.write('a.ts', 'export {};');
    const project = f.project(false, { types: ['./b/index'] });
    const cold = collect(project);
    const warm = collect(project, cold.cache);
    expect(warm.cache.metrics.restoredContexts).toBeGreaterThan(0);
    expect(warm.targets).toEqual([f.file('c.ts')]);
    expect(
      warm.closure.entries.find((entry) => entry.kind === 'type-environment')
        ?.fileName,
    ).toBe(f.file('b/index.d.ts'));
    expect(collect(f.project(), warm.cache).targets).toEqual([]);
  });
  it.each([false, true])(
    'gates an installed workspace type environment with governed=%s',
    (isGoverned) => {
      const f = fixture();
      f.write('a.ts', 'export {};');
      mkdirSync(f.file('node_modules/@types'), { recursive: true });
      symlinkSync(f.file('b'), f.file('node_modules/@types/env'), 'junction');
      const result = collect(f.project(isGoverned, { types: ['env'] }));
      expect(result.closure.incomplete).toEqual([]);
      expect(result.targets).toEqual(isGoverned ? [f.file('c.ts')] : []);
    },
  );
});
