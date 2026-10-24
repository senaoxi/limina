import { createImportAnalysisContext } from '#core/import-analysis/runner';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TypeEvidenceCore } from '../core/type-evidence';
import { createAmbientTypeEvidence } from '../core/type-evidence/ambient-symbol';
import type { ResolveImportEvidenceOptions } from '../core/type-evidence/resolution';
import {
  createBoundedTypeScriptSemanticContext,
  createTypeScriptSemanticDependencySnapshot,
  createWorkspaceSourceBoundary,
} from '../core/typescript-semantic';
import { collectNativeProviderEvidence } from '../core/typescript-semantic/provider-evidence';
import { readFixtureSourceCoverage } from './helpers/native-coverage';
import { createSemanticRepairFixture } from './helpers/semantic-repair';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const compilerOptions = {
  module: 'ESNext',
  moduleResolution: 'Bundler',
  target: 'ES2022',
  types: [],
  strict: true,
  noEmit: true,
};

async function createCase(options: {
  admitted?: boolean;
  declaration?: boolean;
  ambient?: boolean;
  script?: boolean;
}) {
  const target = options.declaration ? 'dep.d.ts' : 'dep.ts';
  const fixture = await createSemanticRepairFixture({
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        ...compilerOptions,
        moduleDetection: 'legacy',
        paths: { dep: [`./${target}`] },
      },
      files: [
        'main.ts',
        ...(options.ambient ? ['env.d.ts'] : []),
        ...(options.admitted ? [target] : []),
      ],
    }),
    'main.ts': "import { value } from 'dep'; export const used = value;",
    'env.d.ts': 'declare module "dep" { export const value: 42; }',
    [target]: options.script
      ? 'const value = 1;'
      : options.declaration
        ? 'export declare const value: 1;'
        : 'export const value = 1;',
    'tsconfig.target.json': JSON.stringify({ files: [target] }),
  });
  cleanups.push(fixture.cleanup);
  return { fixture, target };
}

function evidenceCore(
  fixture: Awaited<ReturnType<typeof createSemanticRepairFixture>>,
  target: string,
  extraConfigs: string[] = [],
) {
  const parsed = fixture.parse();
  const boundary = createWorkspaceSourceBoundary(
    [...parsed.fileNames, fixture.path(target)],
    undefined,
    readFixtureSourceCoverage([
      fixture.path('tsconfig.json'),
      ...extraConfigs.map((name) => fixture.path(name)),
    ]),
  );
  const measurements: { name: string; count?: number }[] = [];
  const core = new TypeEvidenceCore({
    generation: 1,
    importAnalysis: createImportAnalysisContext({
      projectRootDir: fixture.root,
    }),
    workspaceSourceBoundaryProvider: () => boundary,
    metrics: {
      record: (measurement) => {
        measurements.push(measurement);
      },
    },
  });
  const project: ResolveImportEvidenceOptions['project'] = {
    checkerPresets: ['tsc'],
    configPath: fixture.path('tsconfig.json'),
    extensions: [],
    fileNames: parsed.fileNames,
    options: parsed.options,
    projectReferences: parsed.projectReferences,
    resolverConfigPath: fixture.path('tsconfig.json'),
  };
  const context = core.getTypeScriptSemanticContext({
    checkerName: 'tsc',
    project,
  });
  const record = context.getImportRecords(fixture.path('main.ts'))[0]!;
  return { context, core, measurements, project, record };
}

function explicitProviderEvidence(
  context: ReturnType<typeof evidenceCore>['context'],
  record: ReturnType<typeof evidenceCore>['record'],
) {
  return collectNativeProviderEvidence({
    context,
    record,
    resolution: context.resolveImportRecord(record),
    tsModule: ts,
    getAmbientEvidence: createAmbientTypeEvidence,
  });
}

describe('bounded native provider evidence', () => {
  it.each([
    {
      specifier: 'mapped?raw',
      target: 'foo.ts',
      ambient: false,
      admitted: true,
      type: 'checker-source',
      relation: null,
    },
    {
      specifier: 'mapped#fragment',
      target: 'foo.ts',
      ambient: false,
      admitted: false,
      type: 'missing',
      relation: null,
    },
    {
      specifier: 'mapped?raw',
      target: 'foo.ts',
      ambient: true,
      admitted: false,
      type: 'ambient',
      relation: null,
    },
    {
      specifier: 'mapped?raw',
      target: 'foo.d.ts',
      ambient: false,
      admitted: true,
      type: 'concrete-declaration',
      relation: null,
    },
  ])(
    'preserves the checker result for an exact paths key: %j',
    async (testCase) => {
      const { specifier, target, ambient, admitted } = testCase;
      const fixture = await createSemanticRepairFixture({
        'tsconfig.json': JSON.stringify({
          compilerOptions: {
            ...compilerOptions,
            paths: { [specifier]: [`./${target}`] },
          },
          files: [
            'main.ts',
            ...(admitted ? [target] : []),
            ...(ambient ? ['env.d.ts'] : []),
          ],
        }),
        'main.ts': `import { value } from '${specifier}'; export const used = value;`,
        [target]: target.endsWith('.d.ts')
          ? 'export declare const value: 42;'
          : 'export const value = 42;',
        'env.d.ts': `declare module '${specifier}' { export const value: 42; }`,
      });
      cleanups.push(fixture.cleanup);
      const { core, context, record } = evidenceCore(fixture, target);
      try {
        const fact = context.getDependencyFact(record);
        expect(fact.resolution.target?.resolvedFileName).toBe(
          fixture.path(target),
        );
        expect(explicitProviderEvidence(context, record).kind).toBe(
          testCase.type,
        );
        expect(fact.referenceRequirement?.kind ?? null).toBe(testCase.relation);
        expect(fact.admission).toBe(admitted ? 'admitted' : 'excluded');
      } finally {
        core.dispose();
      }
    },
  );

  it.each([
    { admitted: false, declaration: false, expected: 'missing' },
    { admitted: true, declaration: false, expected: 'checker-source' },
    { admitted: true, declaration: false, script: true, expected: 'missing' },
    { admitted: false, declaration: true, expected: 'missing' },
    { admitted: true, declaration: true, expected: 'concrete-declaration' },
    { admitted: true, declaration: true, ambient: true, expected: 'ambient' },
    { admitted: false, declaration: true, ambient: true, expected: 'ambient' },
    { admitted: false, declaration: false, ambient: true, expected: 'ambient' },
  ])('proves the occurrence provider for %j', async (options) => {
    const { fixture, target } = await createCase(options);
    const { core, context, project, record, measurements } = evidenceCore(
      fixture,
      target,
      ['tsconfig.target.json'],
    );
    try {
      const fact = context.getDependencyFact(record);
      expect(fact.resolution.target?.resolvedFileName).toBe(
        fixture.path(target),
      );
      expect(fact.admission).toBe(options.admitted ? 'admitted' : 'excluded');
      expect(explicitProviderEvidence(context, record).kind).toBe(
        options.expected,
      );
      expect(fact.referenceRequirement).toBeNull();
      const symbol = context.getSymbolAtImportRecord(record);
      if (options.expected === 'missing') expect(symbol).toBeUndefined();
      if (
        ['checker-source', 'concrete-declaration'].includes(options.expected)
      ) {
        expect(symbol?.declarations).toContain(
          context.getSourceFile(fixture.path(target)),
        );
        expect(explicitProviderEvidence(context, record)).toEqual({
          kind: options.expected,
          filePath: fixture.path(target),
        });
      }
      const request = { checkerName: 'tsc', project, importRecord: record };
      expect(core.resolveImportEvidence(request).type).toEqual(
        explicitProviderEvidence(context, record),
      );
      expect(core.resolveImportEvidence(request).type).toEqual(
        explicitProviderEvidence(context, record),
      );
      expect(core.cache.programCache.size).toBe(1);
      expect(core.cache.importTypeEvidenceCache.size).toBe(1);
      expect(
        measurements.filter(
          (entry) =>
            entry.name === 'typescript-program-create' && entry.count !== 0,
        ),
      ).toHaveLength(1);
      expect(
        measurements.some(
          (entry) =>
            entry.name === 'type-evidence-cache-hit' && entry.count !== 0,
        ),
      ).toBe(true);
      if (options.script)
        expect(
          ts
            .getPreEmitDiagnostics(context.program)
            .map((diagnostic) => diagnostic.code),
        ).toContain(2306);
      const snapshot = createTypeScriptSemanticDependencySnapshot({
        context,
        fileNames: project.fileNames,
      });
      core.completeProject(project.configPath);
      expect(core.cache.programCache.size).toBe(0);
      expect(core.cache.typeEvidenceProviderCache.size).toBe(0);
      expect(snapshot.getDependencyFact(record)).toEqual(fact);
      expect(() => context.getSourceFile(record.filePath)).toThrow('disposed');
      expect(() => core.resolveImportEvidence(request)).toThrow(
        'already completed',
      );
    } finally {
      core.dispose();
    }
  });

  it.each(['early', 'late', 'jsx'] as const)(
    'keeps non-root implementations outside the frontier even when %s declarations request them',
    async (arrival) => {
      const isJsx = arrival === 'jsx';
      const main = isJsx ? 'main.tsx' : 'main.ts';
      const environment = arrival === 'early' ? 'a-env.d.ts' : 'z-env.d.ts';
      const fixture = await createSemanticRepairFixture({
        'tsconfig.json': JSON.stringify({
          compilerOptions: {
            ...compilerOptions,
            noLib: true,
            jsx: 'react-jsx',
            jsxImportSource: 'runtime',
            paths: { 'runtime/jsx-runtime': ['./runtime.d.ts'] },
          },
          files: [main, ...(isJsx ? [] : [environment])],
        }),
        [main]: `import { value } from './foreign'; export { value }; ${isJsx ? 'export const view = <div />;' : ''}`,
        [environment]: '/// <reference path="./foreign.ts" />',
        'runtime.d.ts':
          '/// <reference path="./foreign.ts" />\nexport declare const jsx: any; export namespace JSX { interface IntrinsicElements { div: any } }',
        'foreign.ts': 'export const value = 1;',
        'tsconfig.support.json': JSON.stringify({
          files: ['foreign.ts', 'runtime.d.ts'],
        }),
      });
      cleanups.push(fixture.cleanup);
      const parsed = fixture.parse();
      const coverage = readFixtureSourceCoverage([
        fixture.path('tsconfig.json'),
        fixture.path('tsconfig.support.json'),
      ]);
      const context = createBoundedTypeScriptSemanticContext({
        configPath: fixture.path('tsconfig.json'),
        fileNames: parsed.fileNames,
        options: parsed.options,
        workspaceSourceBoundary: createWorkspaceSourceBoundary(
          [...parsed.fileNames, fixture.path('foreign.ts')],
          undefined,
          coverage,
        ),
      });
      try {
        const record = context
          .getImportRecords(fixture.path(main))
          .find((item) => item.specifier === './foreign')!;
        expect(context.getDependencyFact(record)).toMatchObject({
          admission: 'excluded',
          referenceRequirement: null,
        });
        expect(explicitProviderEvidence(context, record)).toEqual({
          kind: 'missing',
        });
        expect(context.program.getRootFileNames()).not.toContain(
          fixture.path('foreign.ts'),
        );
        expect(
          context.getSourceFile(fixture.path('foreign.ts')),
        ).toBeUndefined();
        const oracle = ts.createProgram({
          rootNames: parsed.fileNames,
          options: parsed.options,
        });
        expect(oracle.getSourceFile(fixture.path('foreign.ts'))).toBeDefined();
      } finally {
        context.dispose();
      }
    },
  );

  it.each([false, true])(
    'retains real Project Reference mapping without exempting its uncovered output with built=%s',
    async (built) => {
      const fixture = await createSemanticRepairFixture({
        'tsconfig.json': JSON.stringify({
          compilerOptions: {
            ...compilerOptions,
            paths: { dep: ['./b/value.ts'] },
          },
          files: ['main.ts'],
          references: [{ path: './b' }],
        }),
        'main.ts': "import { value } from 'dep'; export const used = value;",
        'b/tsconfig.json': JSON.stringify({
          compilerOptions: {
            ...compilerOptions,
            noEmit: false,
            composite: true,
            declaration: true,
            emitDeclarationOnly: true,
            outDir: 'out',
          },
          files: ['value.ts'],
        }),
        'b/value.ts': 'export const value = 1;',
      });
      cleanups.push(fixture.cleanup);
      if (built) {
        const host = ts.createSolutionBuilderHost(ts.sys);
        expect(
          ts
            .createSolutionBuilder(host, [fixture.path('b/tsconfig.json')], {})
            .build(),
        ).toBe(0);
      }
      const { core, context, project, record } = evidenceCore(
        fixture,
        'b/value.ts',
      );
      try {
        const fact = context.getDependencyFact(record);
        expect(fact.resolution.target?.resolvedFileName).toBe(
          fixture.path('b/value.ts'),
        );
        expect(fact.admission).toBe('excluded');
        expect(explicitProviderEvidence(context, record)).toEqual({
          kind: 'missing',
        });
        expect(fact.referenceRequirement).toBeNull();
        expect(fact.redirect).toEqual({
          originalTarget: fixture.path('b/value.ts'),
          declarationTarget: fixture.path('b/out/value.d.ts'),
          referenceConfig: fixture.path('b/tsconfig.json'),
          availability: built ? 'present' : 'missing',
        });
        expect(
          context.getSourceFile(fixture.path('b/value.ts')),
        ).toBeUndefined();
        expect(context.getSymbolAtImportRecord(record)).toBeUndefined();
        const oracle = ts.createProgram({
          rootNames: project.fileNames,
          options: project.options,
          projectReferences: project.projectReferences,
        });
        if (built)
          expect(
            oracle.getSourceFile(fixture.path('b/value.ts'))?.fileName,
          ).toBe(fixture.path('b/out/value.d.ts'));
        else {
          expect(
            ts
              .getPreEmitDiagnostics(oracle)
              .map((diagnostic) => diagnostic.code),
          ).toContain(6305);
        }
        const resolve = vi.fn(() => null);
        expect(
          core.resolveImportEvidence({
            checkerName: 'tsc',
            importRecord: record,
            project,
            managedOutputLookup: { resolve },
          }).type,
        ).toEqual(explicitProviderEvidence(context, record));
        expect(resolve).not.toHaveBeenCalled();
      } finally {
        core.dispose();
      }
    },
  );

  it.each([
    { ambient: true, suffix: '?raw' },
    { ambient: false, suffix: '?raw' },
    { ambient: false, suffix: '#fragment' },
  ])(
    'keeps Program membership of foo.ts separate from a ./foo.ts$suffix occurrence (ambient=$ambient)',
    async ({ ambient, suffix }) => {
      const fixture = await createSemanticRepairFixture({
        'tsconfig.json': JSON.stringify({
          compilerOptions,
          files: ['main.ts', 'foo.ts', ...(ambient ? ['env.d.ts'] : [])],
        }),
        'main.ts': `import raw from './foo.ts${suffix}'; export const used = raw;`,
        'foo.ts': 'export const value = 1;',
        'env.d.ts':
          'declare module "*?raw" { const value: string; export default value; }',
      });
      cleanups.push(fixture.cleanup);
      const { core, context, record } = evidenceCore(fixture, 'foo.ts');
      try {
        const fact = context.getDependencyFact(record);
        // The complete specifier reached TypeScript and did not resolve.
        expect(fact.resolution.target).toBeNull();
        expect(fact.admission).toBe('unresolved');
        expect(fact.referenceRequirement).toBeNull();
        expect(explicitProviderEvidence(context, record)).toEqual(
          ambient
            ? {
                declarationFilePaths: [fixture.path('env.d.ts')],
                kind: 'ambient',
                modulePattern: '*?raw',
              }
            : { kind: 'missing' },
        );
        // foo.ts is a Program member because it is a root, not because the
        // queried occurrence imported it.
        const member = context.getSourceFile(fixture.path('foo.ts'));
        expect(member?.fileName).toBe(fixture.path('foo.ts'));
        const declarations =
          context.getSymbolAtImportRecord(record)?.declarations ?? [];
        expect(declarations).not.toContain(member);
      } finally {
        core.dispose();
      }
    },
  );
});
