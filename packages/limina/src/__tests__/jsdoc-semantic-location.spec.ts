import { parseCheckerProjectConfigForContext } from '#checkers';
import { compareCodeUnits } from '#utils/collections';
import { mkdir, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { observeFrameworkTypeEvidence } from '../core/framework-semantic/provider-observation';
import { collectTypeScriptSourceFileImports } from '../core/import-analysis/typescript-imports';
import {
  findImportRecordLiteral,
  findImportRecordLiterals,
} from '../core/typescript-semantic/import-record';
import { nativeContextInputs } from '../core/typescript-semantic/native-context-inputs';
import { NativeObservationAdapter } from '../core/typescript-semantic/native-observation-adapter';
import { nativeProgramSource } from '../core/typescript-semantic/native-program-api';
import { createWorkspaceSourceBoundary } from '../core/typescript-semantic/workspace-source-boundary';
import { VueSemanticContextManager } from '../core/vue-semantic/context';
import { collectSemanticDependencyEvidence } from '../core/vue-semantic/dependency';
import { observeVueDependency } from '../core/vue-semantic/dependency-observation';
import { readFixtureSourceCoverage } from './helpers/native-coverage';
import { createSemanticRepairFixture } from './helpers/semantic-repair';

const require = createRequire(import.meta.url);
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});
const options = {
  allowJs: true,
  checkJs: true,
  noLib: true,
  types: [],
  module: 'NodeNext',
  moduleResolution: 'NodeNext',
};

async function fixture(
  files: Record<string, string>,
  extra: Record<string, unknown> = {},
) {
  const fixture = await createSemanticRepairFixture({
    'package.json': JSON.stringify({
      name: 'jsdoc-fixture',
      private: true,
      type: 'module',
    }),
    'tsconfig.json': JSON.stringify({
      compilerOptions: { ...options, ...extra },
      files: Object.keys(files).filter(
        (file) => /\.(?:mjs|cjs|js|ts)$/.test(file) && !file.endsWith('.d.ts'),
      ),
    }),
    ...files,
  });
  cleanups.push(fixture.cleanup);
  return fixture;
}

async function vueFixture(
  files: Record<string, string>,
  extra: Record<string, unknown> = {},
) {
  const f = await fixture(files, extra);
  for (const name of ['vue-tsc', '@types/node']) {
    const target = f.path('node_modules', name);
    await mkdir(path.dirname(target), { recursive: true });
    await symlink(
      path.dirname(require.resolve(`${name}/package.json`)),
      target,
      'junction',
    );
  }
  const parsed = parseCheckerProjectConfigForContext({
    configPath: f.path('tsconfig.json'),
    context: { checkerPresets: ['vue-tsc'], extensions: ['.vue'] },
    projectRootDir: f.root,
  });
  const manager = new VueSemanticContextManager();
  cleanups.push(() => manager.dispose());
  const context = manager.acquire(parsed.vueSemanticIdentity!);
  const records = (file: string) => {
    const sourceFile = context.getSemanticSourceFile(f.path(file))!;
    return collectTypeScriptSourceFileImports({
      filePath: f.path(file),
      sourceFile,
      tsModule: context.tsModule,
    });
  };
  return { ...f, context, records };
}

const original =
  "/** @param {import('node:test').TestContext} context */\nexport function fixture(context) { context.after(() => {}); }\n";

describe('JSDoc occurrence location and actual Program observation', () => {
  it('locates a batch of repeated imports with linear AST work and fresh mutable nodes', () => {
    const text = Array.from({ length: 128 }, () => "import './same.js';").join(
      '\n',
    );
    const sourceFile = ts.createSourceFile(
      '/virtual/entry.ts',
      text,
      ts.ScriptTarget.Latest,
      true,
    );
    const records = collectTypeScriptSourceFileImports({
      filePath: sourceFile.fileName,
      sourceFile,
    });
    const forEachChild = vi.fn(ts.forEachChild);
    const tsModule = { ...ts, forEachChild } as typeof ts;
    const batch = findImportRecordLiterals({ records, sourceFile, tsModule });
    expect(batch.values().toArray()).toEqual(
      sourceFile.statements.map(
        (statement) => (statement as ts.ImportDeclaration).moduleSpecifier,
      ),
    );
    // Work may scale with syntax size, never with syntax size times occurrence count.
    expect(forEachChild.mock.calls.length).toBeLessThan(128 * 8);
    const literal = (sourceFile.statements[0] as ts.ImportDeclaration)
      .moduleSpecifier as ts.StringLiteral;
    literal.text = './changed.js';
    expect(
      findImportRecordLiterals({ records, sourceFile, tsModule }).get(
        records[0]!,
      ),
    ).toBeNull();
  });

  it('rejects ambiguous parsed nodes sharing a specifier and exact range', () => {
    const sourceFile = ts.createSourceFile(
      '/virtual/entry.ts',
      "import './same.js';\nimport './same.js';",
      ts.ScriptTarget.Latest,
      true,
    );
    const records = collectTypeScriptSourceFileImports({
      filePath: sourceFile.fileName,
      sourceFile,
    });
    const [first, second] = sourceFile.statements.map(
      (statement) =>
        (statement as ts.ImportDeclaration).moduleSpecifier as ts.StringLiteral,
    );
    ts.setTextRange(second!, first!);
    const batch = findImportRecordLiterals({
      records,
      sourceFile,
      tsModule: ts,
    });
    expect(batch.values().toArray()).toEqual([null, null]);
  });

  it('round 1: locates the original node:test sample and observes its actual ambient symbol', async () => {
    const f = await vueFixture(
      { 'entry.mjs': original },
      { noLib: false, types: ['node'] },
    );
    const record = f.records('entry.mjs')[0]!;
    const source = f.context.program.getSourceFile(f.path('entry.mjs'))!;
    const literal = nativeProgramSource(source).imports.find(
      (item) => item.text === 'node:test',
    )!;
    expect(source.text).toBe(original);
    expect([record.locator.sourceStart, record.locator.sourceEnd]).toEqual([
      literal.getStart(source),
      literal.end,
    ]);
    expect(
      findImportRecordLiteral({
        importRecord: record,
        sourceFile: source,
        tsModule: ts,
      }),
    ).toBe(literal);
    const evidence = collectSemanticDependencyEvidence({
      context: f.context,
      importRecord: record,
    });
    expect(evidence.kind).toBe('supported');
    expect(
      observeVueDependency({
        context: f.context,
        importRecord: record,
        target: null,
      }).typeEvidence,
    ).toMatchObject({ kind: 'ambient', modulePattern: 'node:test' });
  });

  it('round 1: retains repeated UTF-16 ranges, @import tags and ordinary imports as separate occurrences', async () => {
    const text = [
      '// 中文😀',
      "import './types.js';",
      "/** @typedef {import('./types.js').Value} First */",
      "/** @param {import('./types.js').Value} value */",
      'export function accept(value) { return value; }',
      "/** @import { Value } from './types.js' */",
      '/** @type {Value} */',
      'export const value = 1;',
    ].join('\r\n');
    const f = await vueFixture({
      'entry.mjs': text,
      'types.d.ts': 'export type Value = number;',
    });
    const records = f.records('entry.mjs');
    expect(records).toHaveLength(4);
    const source = f.context.program.getSourceFile(f.path('entry.mjs'))!;
    const inventory = nativeProgramSource(source).imports;
    expect(inventory).toHaveLength(4);
    const batch = findImportRecordLiterals({
      records,
      sourceFile: source,
      tsModule: ts,
    });
    expect(batch.values().toArray()).toEqual(inventory);
    const misplaced = {
      ...records[0]!,
      locator: { ...records[0]!.locator, sourceStart: 0 },
    };
    expect(
      findImportRecordLiterals({
        records: [misplaced],
        sourceFile: source,
        tsModule: ts,
      }).get(misplaced),
    ).toBeNull();
    for (const record of records) {
      const literal = findImportRecordLiteral({
        importRecord: record,
        sourceFile: source,
        tsModule: ts,
      });
      expect(inventory).toContain(literal);
      expect(
        text.slice(record.locator.sourceStart, record.locator.sourceEnd),
      ).toBe("'./types.js'");
      expect(
        observeVueDependency({
          context: f.context,
          importRecord: record,
          target: null,
        }).typeEvidence,
      ).toMatchObject({
        kind: 'concrete-declaration',
        filePath: f.path('types.d.ts'),
      });
    }
    expect(
      new Set(records.map((record) => record.locator.sourceStart)).size,
    ).toBe(4);
  });

  it.each([false, true])(
    'round 2: preserves Native inventory and physical frontier with noResolve=%s',
    async (noResolve) => {
      const f = await fixture(
        {
          'entry.mjs':
            "/** @type {import('./outside.js').Value} */\nexport const value = 1;",
          'healthy.ts': "import './missing.js'; export {};",
          'outside.d.ts': "import './hidden.js'; export type Value = number;",
          'hidden.d.ts': 'export {};',
        },
        { noResolve },
      );
      const parsed = f.parse();
      const project = {
        configPath: f.path('tsconfig.json'),
        fileNames: parsed.fileNames,
        options: parsed.options,
        workspaceSourceBoundary: createWorkspaceSourceBoundary(
          parsed.fileNames,
          undefined,
          readFixtureSourceCoverage([f.path('tsconfig.json')]),
        ),
      };
      const adapter = new NativeObservationAdapter(
        nativeContextInputs(project),
      );
      const source = adapter.program.getSourceFile(f.path('entry.mjs'))!;
      const inventory = nativeProgramSource(source).imports;
      expect(inventory.map((literal) => literal.text)).toEqual([
        './outside.js',
      ]);
      expect(
        adapter.modules.find((item) => item.source === source)?.literal,
      ).toBe(inventory[0]);
      expect(
        adapter.snapshot.requests.map((request) => request.specifier),
      ).toEqual(expect.arrayContaining(['./outside.js', './missing.js']));
      expect(
        adapter.program
          .getSourceFiles()
          .map((file) => file.fileName)
          .sort(compareCodeUnits),
      ).toEqual(
        [
          f.path('entry.mjs'),
          f.path('healthy.ts'),
          ...(noResolve ? [] : [f.path('hidden.d.ts'), f.path('outside.d.ts')]),
        ].sort(compareCodeUnits),
      );
      expect(
        adapter.snapshot.requests.some(
          (request) => request.specifier === './hidden.js',
        ),
      ).toBe(!noResolve);
      expect(adapter.snapshot.failures).toEqual([]);
      expect(adapter.snapshot.obligations).toHaveLength(noResolve ? 2 : 3);
      const oracle = ts.createProgram(parsed.fileNames, parsed.options);
      const oracleSource = oracle.getSourceFile(f.path('entry.mjs'))!;
      expect(
        nativeProgramSource(oracleSource).imports.map((literal) => [
          literal.text,
          literal.getStart(source),
          literal.end,
        ]),
      ).toEqual(
        inventory.map((literal) => [
          literal.text,
          literal.getStart(source),
          literal.end,
        ]),
      );
    },
  );

  it('round 3: keeps documentation, mismatched locations and missing Program inventory unavailable without losing independent evidence', async () => {
    const f = await vueFixture({
      'entry.mjs': [
        "// documentation import('./decoy.js')",
        "/** @type {import('./types.js').Value} */",
        'export const value = 1;',
      ].join('\n'),
      'healthy.mjs':
        "/** @type {import('./types.js').Value} */\nexport const value = 2;",
      'types.d.ts': 'export type Value = number;',
    });
    const [decoy, record] = f.records('entry.mjs');
    expect(
      collectSemanticDependencyEvidence({
        context: f.context,
        importRecord: decoy!,
      }).kind,
    ).toBe('unsupported');
    const shifted = {
      ...record!,
      locator: {
        ...record!.locator,
        sourceStart: record!.locator.sourceStart + 3,
      },
    };
    expect(
      collectSemanticDependencyEvidence({
        context: f.context,
        importRecord: shifted,
      }).kind,
    ).toBe('unsupported');
    const collected = collectSemanticDependencyEvidence({
      context: f.context,
      importRecord: record!,
    });
    expect(collected.kind).toBe('supported');
    if (collected.kind !== 'supported') throw new Error(collected.reason);
    const candidate = collected.candidates[0]!;
    const programSource = f.context.program.getSourceFile(f.path('entry.mjs'))!;
    expect(candidate.containingSourceFile).not.toBe(programSource);
    const compilerSource = nativeProgramSource(programSource);
    const saved = compilerSource.imports;
    const checker = vi.spyOn(f.context.program, 'getTypeChecker');
    try {
      Reflect.deleteProperty(compilerSource, 'imports');
      expect(
        observeFrameworkTypeEvidence({
          candidate,
          program: f.context.program,
          checkerName: 'vue-tsc',
          tsModule: ts,
        }).kind,
      ).toBe('unsupported-checker');
      expect(checker).not.toHaveBeenCalled();
    } finally {
      compilerSource.imports = saved;
    }
    expect(
      observeVueDependency({
        context: f.context,
        importRecord: f.records('healthy.mjs')[0]!,
        target: null,
      }).typeEvidence,
    ).toMatchObject({
      kind: 'concrete-declaration',
      filePath: f.path('types.d.ts'),
    });
  });
  it.each(['entry.ts', 'entry.d.ts'])(
    'round 3: does not promote ignored JSDoc in %s into Program evidence',
    async (file) => {
      const f = await vueFixture({
        [file]:
          "/** @type {import('./types.js').Value} */\nexport const value = 1;",
        'types.d.ts': 'export type Value = number;',
        'tsconfig.json': JSON.stringify({
          compilerOptions: options,
          files: [file],
        }),
      });
      const record = f.records(file)[0]!;
      const source = f.context.program.getSourceFile(f.path(file))!;
      expect(nativeProgramSource(source).imports).toEqual([]);
      expect(
        observeVueDependency({
          context: f.context,
          importRecord: record,
          target: null,
        }).typeEvidence.kind,
      ).toBe('unsupported-checker');
    },
  );

  it('round 3: distinguishes an observed missing target from an unlocatable occurrence', async () => {
    const f = await vueFixture({
      'entry.mjs':
        "/** @type {import('./missing.js').Value} */\nexport const value = 1;",
    });
    const record = f.records('entry.mjs')[0]!;
    expect(
      collectSemanticDependencyEvidence({
        context: f.context,
        importRecord: record,
      }).kind,
    ).toBe('supported');
    expect(
      observeVueDependency({
        context: f.context,
        importRecord: record,
        target: null,
      }).typeEvidence,
    ).toEqual({ kind: 'missing' });
  });
});
