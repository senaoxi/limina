import { normalizeAbsolutePath } from '#utils/path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { collectTypeScriptSourceFileImports } from '../core/import-analysis/typescript-imports';
import { createWorkspaceSourceBoundary } from '../core/typescript-semantic';
import { createBoundedTypeScriptSemanticContext } from '../core/typescript-semantic/context';
import { SourceSyntaxFactsCache } from '../core/typescript-semantic/syntax-cache';
import { OwnedSyntaxScope } from '../core/typescript-semantic/syntax-input';

const cases = [
  'export const answer = 42;',
  "const value = require('plain'); require.resolve('resolved');",
  "function f(require) { return require('shadowed'); } require('global');",
  "import {createRequire as make} from 'node:module'; const load=make(import.meta.url); load('aliased');",
  "import {createRequire} from 'module'; let load=createRequire(import.meta.url); load=other; load('reassigned');",
  String.raw`const x = requ\u0069re('escaped');`,
  String.raw`import {create\u0052equire as make} from 'node:module'; const r=make(import.meta.url); r('escaped-alias');`,
  "/// <reference path='./a.d.ts'/>\n/// <reference types='node'/>\n/** @import {Foo} from 'doc-import' */\nexport type T=import('type-import').T;",
  "const template = `require('not-a-call')`; // require('comment')\nexport const data=/require/;",
  "declare module 'ambient' { export interface Value { x: number } }",
  "import r = require('import-equals'); export {r};",
  "const r = require; r('copied-global');",
  "const require = custom; require('local');",
  "const x=require?.('optional'); require.resolve?.('optional-resolve');",
];

function compare(
  fileName: string,
  options: ts.CompilerOptions,
  cache: SourceSyntaxFactsCache,
) {
  const project = {
    configPath: `${fileName}.json`,
    fileNames: [fileName],
    options,
    workspaceSourceBoundary: createWorkspaceSourceBoundary([fileName]),
  };
  const run = (syntaxFacts?: SourceSyntaxFactsCache) => {
    const context = createBoundedTypeScriptSemanticContext(project, {
      syntaxFacts,
    });
    try {
      const records = context.getImportRecords(fileName);
      return {
        records,
        facts: records.map((record) => context.getDependencyFact(record)),
      };
    } finally {
      context.dispose();
    }
  };
  const expected = run();
  expect(run(cache)).toEqual(expected);
  expect(run(cache)).toEqual(expected);
}

describe('raw syntax differential oracle', () => {
  it('preserves 70 adversarial sources through distinct Programs and native parser policies', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'limina-syntax-corpus-'));
    const cache = new SourceSyntaxFactsCache();
    try {
      for (const ext of ['ts', 'mts', 'cts', 'js', 'tsx']) {
        for (const [i, text] of cases.entries()) {
          const fileName = normalizeAbsolutePath(
            path.join(root, `${i}.${ext}`),
          );
          await writeFile(fileName, text);
          for (const moduleDetection of [
            ts.ModuleDetectionKind.Auto,
            ts.ModuleDetectionKind.Force,
            ts.ModuleDetectionKind.Legacy,
          ]) {
            compare(
              fileName,
              {
                noLib: true,
                types: [],
                allowJs: true,
                moduleDetection,
                target: ts.ScriptTarget.ES2020,
                module: ts.ModuleKind.NodeNext,
                moduleResolution: ts.ModuleResolutionKind.NodeNext,
                jsx: ts.JsxEmit.ReactJSX,
              },
              cache,
            );
          }
        }
      }
      expect(cache.statistics.hit).toBeGreaterThan(150);
      expect(cache.statistics.miss).toBeGreaterThan(150);
    } finally {
      cache.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('bypasses 432 foreign parser recipes including custom module callbacks', () => {
    let checks = 0;
    for (const text of cases.slice(0, 9))
      for (const [extension, kind] of [
        ['ts', ts.ScriptKind.TS],
        ['js', ts.ScriptKind.JS],
        ['tsx', ts.ScriptKind.TSX],
      ] as const) {
        for (const target of [ts.ScriptTarget.ES2020, ts.ScriptTarget.Latest])
          for (const implied of [ts.ModuleKind.CommonJS, ts.ModuleKind.ESNext])
            for (const doc of [
              ts.JSDocParsingMode.ParseAll,
              ts.JSDocParsingMode.ParseNone,
            ])
              for (const force of [false, true]) {
                const filePath = `/virtual/input.${extension}`;
                const input: ts.CreateSourceFileOptions = {
                  languageVersion: target,
                  impliedNodeFormat: implied as ts.ResolutionMode,
                  jsDocParsingMode: doc,
                  setExternalModuleIndicator: force
                    ? (file) => {
                        (
                          file as ts.SourceFile & {
                            externalModuleIndicator?: true;
                          }
                        ).externalModuleIndicator = true;
                      }
                    : undefined,
                };
                const sf = ts.createSourceFile(
                  filePath,
                  text,
                  input,
                  false,
                  kind,
                );
                expect(
                  new OwnedSyntaxScope({}, ts).capture(sf, input),
                ).toBeUndefined();
                const expected = collectTypeScriptSourceFileImports({
                  filePath,
                  sourceFile: sf,
                });
                const fresh = ts.createSourceFile(
                  filePath,
                  text,
                  input,
                  false,
                  kind,
                );
                expect(
                  collectTypeScriptSourceFileImports({
                    filePath,
                    sourceFile: fresh,
                  }),
                ).toEqual(expected);
                checks++;
              }
      }
    expect(checks).toBe(432);
  });
});
