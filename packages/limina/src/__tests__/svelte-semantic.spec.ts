import {
  presortedDecodedMap,
  type SourceMapSegment,
} from '@jridgewell/trace-mapping';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { svelte2tsx } from 'svelte2tsx';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import type { ImportRecord } from '../core/import-analysis/runner';
import { prepareSvelteSemanticDependencies } from '../core/svelte-semantic/preparation';
import { mapGeneratedRange } from '../core/svelte-semantic/source-mapping';
import { isSvelteTypeScriptSource } from '../core/svelte-semantic/source-records';
import type { SvelteSemanticToolchain } from '../core/svelte-semantic/toolchain';
import {
  SVELTE_SEMANTIC_ADAPTER_VERSION,
  type SvelteSemanticProject,
} from '../core/svelte-semantic/types';

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
  const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-svelte-semantic-'));
  temporaryDirectories.push(rootDir);
  const appPath = path.join(rootDir, 'App.svelte');
  const childPath = path.join(rootDir, 'Child.svelte');
  const declarationPath = path.join(rootDir, 'globals.d.ts');
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
      configPath: path.join(rootDir, 'tsconfig.json'),
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
      resolverConfigPath: path.join(rootDir, 'tsconfig.json'),
    },
    sourceText,
  };
}

describe('Svelte strict generated dependency provenance', () => {
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
