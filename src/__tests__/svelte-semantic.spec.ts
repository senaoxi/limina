import {
  presortedDecodedMap,
  type SourceMapSegment,
} from '@jridgewell/trace-mapping';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { svelte2tsx } from 'svelte2tsx';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { createImportAnalysisContext } from '../core/import-analysis/context';
import type { ImportRecord } from '../core/import-analysis/runner';
import { createGeneratedSemanticScript } from '../core/svelte-semantic/generated-script';
import { prepareSvelteSemanticDependencies } from '../core/svelte-semantic/preparation';
import { mapGeneratedRange } from '../core/svelte-semantic/source-mapping';
import { isSvelteTypeScriptSource } from '../core/svelte-semantic/source-records';
import type { SvelteSemanticToolchain } from '../core/svelte-semantic/toolchain';
import {
  SVELTE_SEMANTIC_ADAPTER_VERSION,
  type SvelteSemanticProject,
} from '../core/svelte-semantic/types';
import { createFixturePathResolver } from './helpers/path';
import { createSemanticRepairFixture } from './helpers/semantic-repair';

const requireFromTest = createRequire(import.meta.url);
const requireFromSvelte2Tsx = createRequire(
  requireFromTest.resolve('svelte2tsx/package.json'),
);
const compilerPath = requireFromSvelte2Tsx.resolve('svelte/compiler');
const compiler = requireFromSvelte2Tsx(
  compilerPath,
) as SvelteSemanticToolchain['compiler'];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

function createRecord(start: number, end: number): ImportRecord {
  return {
    domain: 'typescript',
    filePath: '/generated/App.svelte.tsx',
    kind: 'static',
    line: 1,
    locator: { occurrence: 0, sourceEnd: end, sourceStart: start },
    specifier: 'dep',
  };
}

function createTrace(
  mappings: SourceMapSegment[][],
  sources = ['/source/App.svelte'],
) {
  return presortedDecodedMap({
    mappings,
    names: [],
    sources,
    sourcesContent: sources.map(() => 'xyz'),
    version: 3,
  });
}

function mapRange(mappings: SourceMapSegment[][], sources?: string[]) {
  return mapGeneratedRange({
    generatedLineStarts: [0],
    generatedRecord: createRecord(0, 3),
    sourceFilePath: '/source/App.svelte',
    sourceLineStarts: [0],
    trace: createTrace(mappings, sources),
  });
}

function createToolchain(): SvelteSemanticToolchain {
  return {
    compiler,
    compilerPath,
    compilerVersion: compiler.VERSION ?? '4.0.0',
    transform: svelte2tsx,
    transformPath: requireFromTest.resolve('svelte2tsx'),
    transformVersion: '0.7.61',
    tsModule: ts,
    typeScriptPath: requireFromTest.resolve('typescript'),
    typeScriptVersion: ts.version,
  };
}

async function createProject(options?: { ambientCss?: boolean }): Promise<{
  appPath: string;
  project: SvelteSemanticProject;
  sourceText: string;
}> {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), 'limina-svelte-semantic-'),
  );
  temporaryDirectories.push(temporaryRoot);
  const fixturePath = createFixturePathResolver(temporaryRoot);
  const rootDir = fixturePath();
  const appPath = fixturePath('App.svelte');
  const childPath = fixturePath('Child.svelte');
  const declarationPath = fixturePath('globals.d.ts');
  const sourceText = [
    '<script lang="ts">',
    '/// <reference types="vitest" />',
    'import Child from "./Child.svelte";',
    'import "./theme.css";',
    '</script>',
    '<Child />',
  ].join('\n');
  await mkdir(rootDir, { recursive: true });
  await writeFile(appPath, sourceText);
  await writeFile(childPath, '<p>child</p>');
  const fileNames = [appPath, childPath];
  if (options?.ambientCss === true) {
    await writeFile(
      declarationPath,
      "declare module '*.css' { const css: string; export default css }\n",
    );
    fileNames.push(declarationPath);
  }
  return {
    appPath,
    project: {
      adapterVersion: SVELTE_SEMANTIC_ADAPTER_VERSION,
      configPath: fixturePath('tsconfig.json'),
      extensions: ['.svelte'],
      fileNames,
      generation: 1,
      options: {
        allowJs: true,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        noEmit: true,
        skipLibCheck: true,
        target: ts.ScriptTarget.ESNext,
      },
      packageRootDir: rootDir,
      resolverConfigPath: fixturePath('tsconfig.json'),
    },
    sourceText,
  };
}

describe('Svelte strict generated dependency provenance', () => {
  it.each([
    { label: 'active', exports: { '.': './Child.svelte' }, stable: true },
    {
      label: 'inactive',
      exports: { '.': { never: './Child.svelte' } },
      stable: false,
    },
    {
      label: 'blocked types',
      exports: { '.': { types: null, default: './Child.svelte' } },
      stable: false,
    },
  ])(
    'uses the Svelte resolver host for a consumed self-name export ($label)',
    async ({ exports, stable }) => {
      const { project } = await createProject();
      const root = project.packageRootDir;
      const fixturePath = createFixturePathResolver(root);
      const manifest = {
        name: 'svelte-export-fixture',
        type: 'module',
        exports,
      };
      await writeFile(fixturePath('package.json'), JSON.stringify(manifest));
      await writeFile(fixturePath('tsconfig.json'), '{}');
      await mkdir(fixturePath('node_modules'));
      for (const [name, manifestPath] of [
        ['svelte', requireFromSvelte2Tsx.resolve('svelte/package.json')],
        ['svelte2tsx', requireFromTest.resolve('svelte2tsx/package.json')],
        ['typescript', requireFromTest.resolve('typescript/package.json')],
      ]) {
        await symlink(
          path.dirname(manifestPath!),
          fixturePath('node_modules', name!),
          'junction',
        );
      }
      const importAnalysis = createImportAnalysisContext();
      try {
        const consumerPath = fixturePath('Consumer.svelte');
        await writeFile(
          consumerPath,
          `<script lang="ts">import Child from '${manifest.name}';</script><Child />`,
        );
        const prepared = importAnalysis.prepareCheckerSemanticDependencies({
          filePath: consumerPath,
          context: {
            configPath: project.configPath,
            resolverConfigPath: project.configPath,
            extensions: [...project.extensions],
            checkerPresets: [],
            semanticFamily: 'svelte',
            svelteSemanticProject: {
              ...project,
              fileNames: [...project.fileNames, consumerPath],
            },
          },
        });
        expect(prepared.kind).toBe('supported');
        if (prepared.kind !== 'supported')
          throw new Error(JSON.stringify(prepared));
        const fact = prepared.facts.find(
          (fact) => fact.importRecord.specifier === manifest.name,
        );
        expect(fact).toBeDefined();
        expect(fact!.target?.resolvedFileName ?? null).toBe(
          stable ? fixturePath('Child.svelte') : null,
        );
      } finally {
        importAnalysis.dispose?.();
      }
    },
  );

  it('accepts explicitly dense, monotonic, continuous mappings', () => {
    expect(
      mapRange([
        [
          [0, 0, 0, 0],
          [1, 0, 0, 1],
          [2, 0, 0, 2],
        ],
      ]),
    ).toEqual({ kind: 'mapped', range: { end: 3, start: 0 } });
  });

  it.each([
    {
      label: 'sparse gap',
      mappings: [
        [
          [0, 0, 0, 0],
          [2, 0, 0, 2],
        ],
      ],
    },
    {
      label: 'explicit unmapped segment',
      mappings: [[[0, 0, 0, 0], [1], [2, 0, 0, 2]]],
    },
    {
      label: 'backward original offset',
      mappings: [
        [
          [0, 0, 0, 0],
          [1, 0, 0, 2],
          [2, 0, 0, 1],
        ],
      ],
    },
    {
      label: 'forward original offset jump',
      mappings: [
        [
          [0, 0, 0, 0],
          [1, 0, 0, 2],
          [2, 0, 0, 3],
        ],
      ],
    },
  ] satisfies { label: string; mappings: SourceMapSegment[][] }[])(
    'fails closed for $label',
    ({ mappings }) => {
      expect(mapRange(mappings)).toMatchObject({
        kind: 'source-map-mismatch',
      });
    },
  );

  it('fails closed when one generated offset maps to another source', () => {
    expect(
      mapRange(
        [
          [
            [0, 0, 0, 0],
            [1, 1, 0, 1],
            [2, 0, 0, 2],
          ],
        ],
        ['/source/App.svelte', '/source/Other.svelte'],
      ),
    ).toMatchObject({ kind: 'source-map-mismatch' });
  });

  it('keeps wholly synthetic ranges as unmapped observations', () => {
    expect(mapRange([[]])).toEqual({
      kind: 'unmapped',
    });
  });
});

describe('Svelte public bounded semantic adapter', () => {
  it('keeps absolute Windows source-map paths from being rebased', () => {
    const filePath = 'C:/Users/runneradmin/App.svelte';
    const sourceText = '<script lang="ts">export const value = true</script>';
    const toolchain = createToolchain();
    const generated = createGeneratedSemanticScript({
      filePath,
      generated: toolchain.transform(sourceText, {
        filename: filePath,
        isTsFile: true,
        parse: toolchain.compiler.parse as never,
        version: toolchain.compilerVersion,
      }),
      toolchain,
      project: {
        adapterVersion: SVELTE_SEMANTIC_ADAPTER_VERSION,
        configPath: 'C:/Users/runneradmin/tsconfig.json',
        extensions: ['.svelte'],
        fileNames: [filePath],
        generation: 0,
        options: {},
        packageRootDir: 'C:/Users/runneradmin',
        resolverConfigPath: 'C:/Users/runneradmin/tsconfig.json',
      },
    });

    expect(generated.trace.resolvedSources).toEqual([filePath]);
  });

  it('uses the real public svelte2tsx tuple and generated semantic spelling', async () => {
    const fixture = await createProject();
    const preparation = prepareSvelteSemanticDependencies({
      ...fixture,
      filePath: fixture.appPath,
      toolchain: createToolchain(),
    });

    expect(preparation.kind).toBe('supported');
    if (preparation.kind !== 'supported') return;
    expect(preparation.directSourceRecords).toMatchObject([
      { kind: 'triple-slash-types', specifier: 'vitest' },
    ]);
    expect(
      preparation.facts.map((fact) => ({
        evidence: fact.typeEvidence.kind,
        resolvedBy: fact.target?.resolvedBy ?? null,
        specifier: fact.importRecord.specifier,
      })),
    ).toEqual([
      {
        evidence: 'checker-source',
        resolvedBy: 'checker-source',
        specifier: './Child.svelte',
      },
      { evidence: 'missing', resolvedBy: null, specifier: './theme.css' },
    ]);
    expect(
      preparation.facts.every(
        (fact) => fact.importRecord.filePath === fixture.appPath,
      ),
    ).toBe(true);
  });

  it('separates ambient TypeChecker evidence from a null module target', async () => {
    const fixture = await createProject({ ambientCss: true });
    const preparation = prepareSvelteSemanticDependencies({
      ...fixture,
      filePath: fixture.appPath,
      toolchain: createToolchain(),
    });

    expect(preparation.kind).toBe('supported');
    if (preparation.kind !== 'supported') return;
    const css = preparation.facts.find(
      (fact) => fact.semanticSpecifier === './theme.css',
    );
    expect(css?.target).toBeNull();
    expect(css?.typeEvidence).toMatchObject({
      kind: 'ambient',
      modulePattern: '*.css',
    });
  });

  it('only opts into TSX generation for an explicit script lang', () => {
    expect(isSvelteTypeScriptSource('<script lang="ts"></script>')).toBe(true);
    expect(isSvelteTypeScriptSource('<script lang=typescript></script>')).toBe(
      true,
    );
    expect(isSvelteTypeScriptSource('<script></script>')).toBe(false);
    expect(
      isSvelteTypeScriptSource('<script type="text/typescript"></script>'),
    ).toBe(false);
  });
});

describe('Svelte occurrence-specific conditional exports', () => {
  it.each(['nodenext-static', 'node16-dynamic', 'bundler-require'])(
    'agrees with the generated TypeScript Program: %s',
    async (variant) => {
      const sourceText =
        variant === 'nodenext-static'
          ? '<script lang="ts">import type { Branch } from "dep"; let branch: Branch = "import";</script><p>{branch}</p>'
          : variant === 'node16-dynamic'
            ? '<script lang="ts">async function load() { const module = await import("dep"); const branch: "import" = module.branch; return branch; }</script><p>{load()}</p>'
            : '<script lang="ts">import type { Branch } from "dep" with { "resolution-mode": "require" }; let branch: Branch = "require";</script><p>{branch}</p>';
      const fixture = await createSemanticRepairFixture({
        'package.json': '{"type":"module"}',
        'App.svelte': sourceText,
        'node_modules/dep/package.json':
          '{"name":"dep","type":"module","exports":{"import":"./import.mts","require":"./require.cts"}}',
        'node_modules/dep/import.mts':
          'export type Branch = "import"; export const branch: Branch = "import";',
        'node_modules/dep/require.cts':
          'export type Branch = "require"; export const branch: Branch = "require";',
      });
      const compilerOptions: ts.CompilerOptions = {
        module:
          variant === 'bundler-require'
            ? ts.ModuleKind.ESNext
            : variant === 'node16-dynamic'
              ? ts.ModuleKind.Node16
              : ts.ModuleKind.NodeNext,
        moduleResolution:
          variant === 'bundler-require'
            ? ts.ModuleResolutionKind.Bundler
            : variant === 'node16-dynamic'
              ? ts.ModuleResolutionKind.Node16
              : ts.ModuleResolutionKind.NodeNext,
        target: ts.ScriptTarget.ES2022,
        types: [],
        noEmit: true,
      };
      const project: SvelteSemanticProject = {
        adapterVersion: SVELTE_SEMANTIC_ADAPTER_VERSION,
        configPath: fixture.path('tsconfig.json'),
        extensions: ['.svelte'],
        fileNames: [fixture.path('App.svelte')],
        generation: 0,
        options: compilerOptions,
        packageRootDir: fixture.root,
        resolverConfigPath: fixture.path('tsconfig.json'),
      };
      try {
        const toolchain = createToolchain();
        const generated = toolchain.transform(sourceText, {
          filename: fixture.path('App.svelte'),
          isTsFile: true,
          parse: compiler.parse as never,
          version: toolchain.compilerVersion,
        });
        await writeFile(fixture.path('App.svelte.tsx'), generated.code);
        const captured: {
          target: string | undefined;
          mode: ts.ResolutionMode;
        }[] = [];
        const host = ts.createCompilerHost(compilerOptions);
        host.resolveModuleNameLiterals = (
          literals,
          containingFile,
          redirectedReference,
          options,
          sourceFile,
        ) =>
          literals.map((literal) => {
            const mode = ts.getModeForUsageLocation(
              sourceFile,
              literal,
              options,
            );
            const resolved = ts.resolveModuleName(
              literal.text,
              containingFile,
              options,
              host,
              undefined,
              redirectedReference,
              mode,
            );
            if (literal.text === 'dep')
              captured.push({
                target: resolved.resolvedModule?.resolvedFileName,
                mode,
              });
            return resolved;
          });
        ts.createProgram({
          rootNames: [fixture.path('App.svelte.tsx')],
          options: compilerOptions,
          host,
        });
        const preparation = prepareSvelteSemanticDependencies({
          filePath: fixture.path('App.svelte'),
          project,
          sourceText,
          toolchain,
        });
        expect(preparation.kind).toBe('supported');
        if (preparation.kind !== 'supported')
          throw new Error(preparation.reason);
        const fact = preparation.facts.find(
          (fact) => fact.semanticSpecifier === 'dep',
        )!;
        const expectedTarget = fixture.path(
          'node_modules/dep',
          variant === 'bundler-require' ? 'require.cts' : 'import.mts',
        );
        expect(captured).toEqual([
          {
            target: expectedTarget,
            mode:
              variant === 'bundler-require'
                ? ts.ModuleKind.CommonJS
                : ts.ModuleKind.ESNext,
          },
        ]);
        expect(fact.target?.resolvedFileName).toBe(expectedTarget);
        expect(fact.resolutionMode).toBe(String(captured[0]!.mode));
      } finally {
        await fixture.cleanup();
      }
    },
  );
});
