import { mkdir, symlink } from 'node:fs/promises';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { cloneProjectDependencyPreparation } from '../core/project-dependencies/cache';
import {
  createBoundedTypeScriptSemanticContext,
  createTypeScriptSemanticDependencySnapshot,
  createWorkspaceSourceBoundary,
} from '../core/typescript-semantic';
import { getEffectiveImporterRoots } from '../core/typescript-semantic/effective-roots';
import { createSemanticRepairFixture } from './helpers/semantic-repair';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});
async function fixture(files: Record<string, string>) {
  const value = await createSemanticRepairFixture(files);
  cleanups.push(value.cleanup);
  return value;
}
const options = {
  module: 'NodeNext',
  moduleResolution: 'NodeNext',
  target: 'ES2022',
  types: [],
  strict: true,
  noEmit: true,
};

function context(
  f: Awaited<ReturnType<typeof fixture>>,
  parsed: ts.ParsedCommandLine,
  extra: string[] = [],
) {
  return createBoundedTypeScriptSemanticContext({
    configPath: f.path('tsconfig.json'),
    fileNames: getEffectiveImporterRoots({
      configPath: f.path('tsconfig.json'),
      ...parsed,
    }),
    options: parsed.options,
    workspaceSourceBoundary: createWorkspaceSourceBoundary([
      ...parsed.fileNames,
      ...extra,
    ]),
  });
}

describe('native reference repair independent Program evidence', () => {
  it.each(['relative', 'extends', 'included'])(
    'enumerates explicit environment roots: %s',
    async (variant) => {
      const f = await fixture({
        'package.json': '{"type":"module"}',
        'base.json': JSON.stringify({
          compilerOptions: { ...options, types: ['./env'] },
        }),
        'tsconfig.json': JSON.stringify(
          variant === 'extends'
            ? { extends: './base.json', include: ['src/*.ts'] }
            : {
                compilerOptions: { ...options, types: ['./env'] },
                include:
                  variant === 'included'
                    ? ['src/*.ts', 'env.d.ts']
                    : ['src/*.ts'],
              },
        ),
        'src/main.ts': 'export const value = 1;',
        'env.d.ts':
          "import type { Value } from './provider/value.js'; export {};",
        'provider/value.ts': 'export type Value = number;',
      });
      const parsed = f.parse();
      const oracle = ts.createProgram({
        rootNames: parsed.fileNames,
        options: parsed.options,
      });
      expect(oracle.getSourceFile(f.path('env.d.ts'))).toBeDefined();
      const bounded = context(f, parsed, [f.path('provider/value.ts')]);
      try {
        expect(bounded.getImportRecords(f.path('env.d.ts'))).toHaveLength(1);
        const fact = bounded.getDependencyFact(
          bounded.getImportRecords(f.path('env.d.ts'))[0]!,
        );
        expect(fact.referenceRequirement?.targetFileName).toBe(
          f.path('provider/value.ts'),
        );
        expect(bounded.hasSourceFile(f.path('provider/value.ts'))).toBe(false);
        expect(parsed.fileNames.includes(f.path('env.d.ts'))).toBe(
          variant === 'included',
        );
      } finally {
        bounded.dispose();
      }
    },
  );

  it.each(['react-jsx', 'react-jsxdev', 'pragma', 'react', 'preserve'])(
    'persists only compiler JSX runtime occurrences: %s',
    async (jsx) => {
      const f = await fixture({
        'package.json': '{"type":"module"}',
        'tsconfig.json': JSON.stringify({
          compilerOptions: {
            ...options,
            jsx: jsx === 'pragma' ? 'react-jsx' : jsx,
            jsxImportSource: './runtime',
          },
          files: ['main.tsx'],
        }),
        'main.tsx': `${jsx === 'pragma' ? '/** @jsxImportSource ./override */\n' : ''}export const element = <div />;`,
        'runtime/jsx-runtime.ts':
          'export namespace JSX { export interface IntrinsicElements { div: {} } }',
        'runtime/jsx-dev-runtime.ts':
          'export namespace JSX { export interface IntrinsicElements { div: {} } }',
        'override/jsx-runtime.ts':
          'export namespace JSX { export interface IntrinsicElements { div: {} } }',
      });
      const parsed = f.parse();
      const bounded = context(f, parsed);
      const oracle = ts.createProgram({
        rootNames: parsed.fileNames,
        options: parsed.options,
      });
      try {
        const captured: string[] = [];
        const host = ts.createCompilerHost(parsed.options);
        host.resolveModuleNameLiterals = (
          literals,
          containingFile,
          redirectedReference,
          compilerOptions,
          sourceFile,
        ) =>
          literals.map((literal) => {
            if (literal.pos < 0) captured.push(literal.text);
            return ts.resolveModuleName(
              literal.text,
              containingFile,
              compilerOptions,
              host,
              undefined,
              redirectedReference,
              ts.getModeForUsageLocation(sourceFile, literal, compilerOptions),
            );
          });
        ts.createProgram({
          rootNames: parsed.fileNames,
          options: parsed.options,
          host,
        });
        const records = bounded.getImportRecords(f.path('main.tsx'));
        const runtime = records.filter(
          (record) =>
            bounded.resolveImportRecord(record).channel === 'jsx-runtime',
        );
        expect(runtime).toHaveLength(captured.length);
        for (const record of runtime) {
          expect(
            bounded.resolveImportRecord(record).target?.resolvedFileName,
          ).toBe(
            oracle
              .getSourceFiles()
              .find((file) =>
                file.fileName.endsWith(
                  jsx === 'react-jsxdev'
                    ? '/jsx-dev-runtime.ts'
                    : '/jsx-runtime.ts',
                ),
              )?.fileName,
          );
          if (jsx !== 'pragma')
            expect(record.configurationSource?.configPath).toBe(
              f.path('tsconfig.json'),
            );
        }
        const snapshot = createTypeScriptSemanticDependencySnapshot({
          context: bounded,
          fileNames: parsed.fileNames,
        });
        expect(snapshot.getImportRecords(f.path('main.tsx'))).toEqual(records);
        const snapshotRecord = snapshot.getImportRecords(f.path('main.tsx'))[0];
        if (snapshotRecord?.configurationSource) {
          snapshotRecord.configurationSource.configPath =
            f.path('changed.json');
          expect(snapshot.getImportRecords(f.path('main.tsx'))).toEqual(
            records,
          );
          const preparation = {
            directSourceRecords: [...records],
            facts: [],
            failures: [],
            observations: [],
            ready: true,
          };
          const copied = cloneProjectDependencyPreparation(preparation);
          copied.directSourceRecords[0]!.configurationSource!.configPath =
            f.path('changed.json');
          expect(
            preparation.directSourceRecords[0]!.configurationSource!.configPath,
          ).toBe(f.path('tsconfig.json'));
        }
      } finally {
        bounded.dispose();
      }
    },
  );

  it.each(['external', 'paths', 'augmentation'])(
    'keeps type evidence distinct from compiler membership: %s',
    async (variant) => {
      const f = await fixture({
        'package.json': '{"type":"module"}',
        'tsconfig.json': JSON.stringify({
          compilerOptions: {
            ...options,
            paths:
              variant === 'external'
                ? undefined
                : { dep: ['./provider/index.ts'] },
          },
          files: ['main.ts', 'env.d.ts'],
        }),
        'main.ts': "import type { Value } from 'dep'; export type Use = Value;",
        'env.d.ts': `${variant === 'augmentation' ? "import 'dep'; " : ''}declare module 'dep' { export interface Value { ambient: true } }`,
        'provider/index.ts': 'export interface Value { source: true }',
        'node_modules/dep/package.json':
          '{"name":"dep","type":"module","exports":"./index.ts"}',
        'node_modules/dep/index.ts': 'export interface Value { source: true }',
      });
      const parsed = f.parse();
      const bounded = context(f, parsed, [f.path('provider/index.ts')]);
      try {
        const record = bounded.getImportRecords(f.path('main.ts'))[0]!;
        const fact = bounded.getDependencyFact(record);
        const oracle = ts.createProgram({
          rootNames: parsed.fileNames,
          options: parsed.options,
        });
        const source = oracle.getSourceFile(f.path('main.ts'))!;
        const literal = (source.statements[0] as ts.ImportDeclaration)
          .moduleSpecifier;
        const symbol = oracle.getTypeChecker().getSymbolAtLocation(literal)!;
        expect(symbol.declarations?.some(ts.isSourceFile)).toBe(
          variant === 'augmentation',
        );
        expect(fact.typeEvidence.kind).toBe(
          variant === 'augmentation' ? 'checker-source' : 'ambient',
        );
        expect(fact.referenceRequirement?.kind ?? null).toBe(
          variant === 'external'
            ? null
            : variant === 'paths'
              ? 'compiler-membership'
              : 'source-semantic',
        );
      } finally {
        bounded.dispose();
      }
    },
  );

  it.each([false, true, 'workspace'] as const)(
    'admits external declaration closure while bounding workspace sources: %s',
    async (preserveSymlinks) => {
      const f = await fixture({
        'package.json': '{"type":"module"}',
        'tsconfig.json': JSON.stringify({
          compilerOptions: {
            ...options,
            preserveSymlinks: preserveSymlinks === true,
          },
          files: ['main.ts'],
        }),
        'main.ts':
          "import 'dep'; import type { Value } from 'virtual:dep'; export type Use = Value;",
        'external/package.json':
          '{"name":"dep","type":"module","types":"./index.d.ts"}',
        'external/index.d.ts': "import './inner.js';",
        'external/inner.d.ts':
          "declare module 'virtual:dep' { export type Value = number; }",
      });
      await mkdir(f.path('node_modules'));
      await symlink(f.path('external'), f.path('node_modules/dep'), 'junction');
      const parsed = f.parse();
      const bounded = context(
        f,
        parsed,
        preserveSymlinks === 'workspace' ? [f.path('external/inner.d.ts')] : [],
      );
      try {
        const record = bounded.getImportRecords(f.path('main.ts'))[1]!;
        expect(bounded.getDependencyFact(record).typeEvidence.kind).toBe(
          preserveSymlinks === 'workspace' ? 'missing' : 'ambient',
        );
        expect(bounded.getImportRecords(f.path('main.ts'))).toHaveLength(2);
        const full = ts.createProgram({
          rootNames: parsed.fileNames,
          options: parsed.options,
        });
        expect(ts.getPreEmitDiagnostics(full)).toHaveLength(0);
      } finally {
        bounded.dispose();
      }
    },
  );
});
