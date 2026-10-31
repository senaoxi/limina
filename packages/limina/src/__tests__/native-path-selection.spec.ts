import { compareCodeUnits } from '#utils/collections';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { finishAnalysisOutcome } from '../core/build-graph/analysis-outcome';
import {
  coreCollectionRun,
  recordCoreWork,
} from '../core/build-graph/core-collection-run';
import { retainNativeAnalysis } from '../core/build-graph/native-analysis-evidence';
import type { DependencyAnalysisResult } from '../core/build-graph/types';
import { createProjectDependencyCaches } from '../core/project-dependencies/cache';
import { NativeObservationAdapter } from '../core/typescript-semantic/native-observation-adapter';
import { createNativeObservationContext } from '../core/typescript-semantic/native-observation-context';
import { createWorkspaceSourceBoundary } from '../core/typescript-semantic/workspace-source-boundary';
import type { NativeEvidenceSnapshot } from '../domain/analysis/native-evidence';
import { summarizeCompilationObligation } from '../domain/analysis/native-obligation';
import { readFixtureSourceCoverage } from './helpers/native-coverage';
import { createSemanticRepairFixture } from './helpers/semantic-repair';

const options = {
  target: 'ES2022',
  module: 'NodeNext',
  moduleResolution: 'NodeNext',
  composite: true,
  types: [],
  ignoreDeprecations: '6.0',
};
const config = (files: string[], extra = {}) =>
  JSON.stringify({ compilerOptions: options, files, ...extra });
const cases = [
  'blocked',
  'independent-last',
  'independent-first',
  'independent-root',
  'missing-high',
  'missing-all',
  'noResolve',
  'tsx-high',
  'redirect-covered',
  'redirect-uncovered',
  'redirect-missing',
  'redirect-unavailable',
  'tsx-root',
  'extension-competition',
  'root-uncovered',
  'external-last',
  'external-path',
  'external-chain',
] as const;

describe('path selection survives physical truncation', () => {
  it.each([
    { module: 'ESNext', moduleResolution: 'Bundler' },
    { module: 'NodeNext', moduleResolution: 'NodeNext' },
    { module: 'Node16', moduleResolution: 'Node16', resolveJsonModule: true },
    { module: 'ESNext', moduleResolution: 'Bundler', resolveJsonModule: false },
  ])('uses compiler JSON path defaults for %o', async (overrides) => {
    const compilerOptions = { ...options, ...overrides, noLib: true };
    const fixture = await createSemanticRepairFixture({
      'tsconfig.json': config(['a.ts'], { compilerOptions }),
      'tsconfig.b.json': config(['b.json'], { compilerOptions }),
      'a.ts': '/// <reference path="./b.json" />\nexport {};',
      'b.json': '{"value":1}',
    });
    try {
      const parsed = fixture.parse();
      const coverage = readFixtureSourceCoverage([
        fixture.path('tsconfig.json'),
        fixture.path('tsconfig.b.json'),
      ]);
      const project = {
        configPath: fixture.path('tsconfig.json'),
        fileNames: parsed.fileNames,
        options: parsed.options,
        workspaceSourceBoundary: createWorkspaceSourceBoundary(
          parsed.fileNames,
          undefined,
          coverage,
        ),
      };
      const context = createNativeObservationContext({
        project,
        coverage,
        epoch: '1',
        collectionId: 'json-path',
        sourceVersion: '1',
        typescriptVersion: ts.version,
        typescriptImplementation: 'installed',
        toolchain: 'test',
        authority: {
          phase: 'locked',
          family: 'typescript',
          selectionEvidenceIds: ['selection'],
        },
      });
      const adapter = new NativeObservationAdapter(
        { project, coverage, context },
        ts,
      );
      const oracle = ts.createProgram({
        rootNames: parsed.fileNames,
        options: parsed.options,
      });
      const isSelected =
        oracle.getSourceFile(fixture.path('b.json')) !== undefined;
      const resolution = adapter.snapshot.resolutions.find(
        (item) => item.pathSelection !== undefined,
      )!;
      expect(resolution.pathSelection!.logicalTarget).toBe(
        isSelected ? fixture.path('b.json') : null,
      );
      expect(adapter.snapshot.obligations[0]!.existence.state).toBe(
        isSelected ? 'unknown' : 'absent',
      );
      if (isSelected)
        assertPathAdmission(
          adapter.snapshot,
          project.configPath,
          'unavailable',
        );
    } finally {
      await fixture.cleanup();
    }
  });

  it.each(cases)(
    '%s preserves selection, sources, requests and their ancestry',
    async (mode) => {
      const isIndependent = [
        'independent-last',
        'independent-first',
        'external-last',
        'external-path',
        'external-chain',
      ].includes(mode);
      const isRedirect = mode.startsWith('redirect-');
      const roots =
        mode === 'independent-first'
          ? ['entry.ts', 'a.ts']
          : isIndependent
            ? ['a.ts', 'entry.ts']
            : [
                  'independent-root',
                  'redirect-unavailable',
                  'root-uncovered',
                  'external-last',
                ].includes(mode)
              ? ['a.ts', 'b.d.ts']
              : mode === 'tsx-root'
                ? ['a.ts', 'b.tsx']
                : ['a.ts'];
      const files: Record<string, string> = {
        'package.json': JSON.stringify({
          name: 'workspace-root',
          type: 'module',
          private: true,
          ...(mode.startsWith('external-') && {
            types: './b.d.ts',
            exports: { '.': { types: './b.d.ts' } },
          }),
        }),
        'tsconfig.json': config(roots, {
          ...(isRedirect && { references: [{ path: './tsconfig.b.json' }] }),
          ...(mode === 'noResolve' && {
            compilerOptions: { ...options, noResolve: true },
          }),
        }),
        'tsconfig.b.json': config(['b.ts'], {
          compilerOptions: { ...options, declaration: true, outDir: 'out' },
        }),
        'tsconfig.declaration.json': config(['b.d.ts']),
        'tsconfig.ghost.json': config(['ghost.ts']),
        'a.ts': '/// <reference path="./b" />\nexport const a = 1;',
        'b.ts': 'export const high = 1;',
        'b.d.ts':
          'import type {Ghost} from "./ghost.js"; export interface Low {g: Ghost}',
        'ghost.ts': 'export interface Ghost {value: number}',
        ...(isIndependent && {
          'entry.ts':
            '/// <reference path="./b.d.ts" />\nexport const entry = 1;',
        }),
      };
      if (['missing-high', 'missing-all', 'tsx-high'].includes(mode)) {
        delete files['b.ts'];
        delete files['tsconfig.b.json'];
      }
      switch (mode) {
        case 'tsx-root':
        case 'extension-competition': {
          files['b.tsx'] = 'export const jsx = 1;';
          files['tsconfig.tsx.json'] = config(['b.tsx']);

          break;
        }
        case 'missing-all': {
          delete files['b.d.ts'];
          delete files['tsconfig.declaration.json'];

          break;
        }
        case 'tsx-high': {
          files['b.tsx'] = 'export const high = 1;';
          files['tsconfig.tsx.json'] = config(['b.tsx']);

          break;
        }
        // No default
      }
      if (mode === 'external-chain') {
        files['b.d.ts'] = 'export type {Low} from "./helper.js";';
        files['helper.d.ts'] =
          'import type {Ghost} from "./ghost.js"; export interface Low {g: Ghost}';
        files['tsconfig.helper.json'] = config(['helper.d.ts']);
      }
      const fixture = await createSemanticRepairFixture(files);
      try {
        if (mode.startsWith('external-')) {
          await writeFile(
            fixture.path('entry.ts'),
            'import type {Low} from "low"; export type Entry = Low;',
          );
          if (mode === 'external-path')
            await writeFile(
              fixture.path('b.d.ts'),
              '/// <reference path="./ghost.ts" />\nexport interface Low {}',
            );
          await mkdir(fixture.path('node_modules'), { recursive: true });
          await symlink(
            fixture.root,
            fixture.path('node_modules/low'),
            'junction',
          );
        }
        if (mode === 'redirect-covered' || mode === 'redirect-uncovered') {
          const b = fixture.parse('tsconfig.b.json');
          expect(
            ts
              .createProgram({ rootNames: b.fileNames, options: b.options })
              .emit().emitSkipped,
          ).toBe(false);
        }
        if (mode === 'redirect-covered') {
          files['tsconfig.output.json'] = config(['out/b.d.ts']);
          await writeFile(
            fixture.path('tsconfig.output.json'),
            files['tsconfig.output.json'],
          );
        }
        const parsed = fixture.parse();
        const coverage = readFixtureSourceCoverage(
          Object.keys(files)
            .filter((name) => /^tsconfig.*\.json$/.test(name))
            .filter(
              (name) =>
                mode !== 'root-uncovered' ||
                !['tsconfig.json', 'tsconfig.declaration.json'].includes(name),
            )
            .map((name) => fixture.path(name)),
        );
        const project = {
          configPath: fixture.path('tsconfig.json'),
          fileNames: parsed.fileNames,
          options: parsed.options,
          projectReferences: parsed.projectReferences,
          workspaceSourceBoundary: createWorkspaceSourceBoundary(
            parsed.fileNames,
            undefined,
            coverage,
          ),
        };
        const context = createNativeObservationContext({
          project,
          coverage,
          epoch: '1',
          collectionId: 'path',
          sourceVersion: '1',
          typescriptVersion: ts.version,
          typescriptImplementation: 'installed',
          toolchain: 'test',
          authority: {
            phase: 'locked',
            family: 'typescript',
            selectionEvidenceIds: ['selection'],
          },
        });
        const adapter = new NativeObservationAdapter(
          { project, coverage, context },
          mode === 'redirect-unavailable' ? compilerWithoutReferenceMap() : ts,
        );
        // This independent full Program is an oracle only; production never calls it.
        const oracle = ts.createProgram({
          rootNames: parsed.fileNames,
          options: parsed.options,
          projectReferences: parsed.projectReferences,
        });
        const a = oracle.getSourceFile(fixture.path('a.ts'))!;
        const target = ['noResolve', 'redirect-unavailable'].includes(mode)
          ? undefined
          : (
              oracle as ts.Program & {
                getSourceFileFromReference(
                  source: ts.SourceFile,
                  reference: ts.FileReference,
                ): ts.SourceFile | undefined;
              }
            ).getSourceFileFromReference(a, a.referencedFiles[0]!)?.fileName;
        const request = adapter.snapshot.requests.find(
          (q) =>
            q.sourceFile?.lexicalPath === fixture.path('a.ts') &&
            q.channel === 'path-directive',
        )!;
        expect(
          adapter.snapshot.resolutions.find((r) => r.requestId === request.id)
            ?.target?.lexicalPath,
        ).toBe(target);
        const isGhostExpected = [
          'independent-root',
          'redirect-unavailable',
        ].includes(mode);
        const expectedSources = [
          ...new Set([
            ...roots.filter(
              (name) => mode !== 'root-uncovered' || name !== 'b.d.ts',
            ),
            ...(isGhostExpected ? ['b.d.ts'] : []),
            ...(mode === 'redirect-uncovered' ? ['out/b.d.ts'] : []),
          ]),
        ]
          .map((name) => fixture.path(name))
          .sort(compareCodeUnits);
        expect(
          adapter.program
            .getSourceFiles()
            .filter(
              (source) => !adapter.program.isSourceFileDefaultLibrary(source),
            )
            .map((s) => s.fileName)
            .sort(compareCodeUnits),
        ).toEqual(expectedSources);
        const ghost = adapter.snapshot.requests.find((q) =>
          ['./ghost.js', './ghost.ts'].includes(q.specifier),
        );
        expect(Boolean(ghost)).toBe(isGhostExpected);
        expect(
          adapter.snapshot.relations.some(
            (r) =>
              r.kind === 'resolved-project-use' &&
              r.targetConfigId === fixture.path('tsconfig.ghost.json'),
          ),
        ).toBe(isGhostExpected);
        if (
          ghost &&
          (isIndependent ||
            [
              'independent-root',
              'redirect-unavailable',
              'root-uncovered',
              'external-last',
            ].includes(mode))
        ) {
          const link = adapter.snapshot.traversal.find(
            (l) => l.requestId === ghost.id,
          )!;
          expect(link.parentRequestIds).not.toContain(request.id);
          if (mode === 'external-chain')
            expect(link.parentRequestIds).toContain(
              adapter.snapshot.requests.find(
                (q) => q.specifier === './helper.js',
              )!.id,
            );
          else if (isIndependent)
            expect(link.parentRequestIds).toContain(
              adapter.snapshot.requests.find(
                (q) => q.sourceFile?.lexicalPath === fixture.path('entry.ts'),
              )!.id,
            );
          else expect(link.rootFileNames).toContain(fixture.path('b.d.ts'));
        }
        expect(adapter.program.getRootFileNames()).toEqual(parsed.fileNames);
        expect(adapter.snapshot.failures).toEqual([]);
        if (mode.startsWith('external-')) {
          const declaration = oracle.getSourceFile(fixture.path('b.d.ts'))!;
          expect(oracle.isSourceFileFromExternalLibrary(declaration)).toBe(
            true,
          );
          expect(ghost).toBeUndefined();
          expect(adapter.snapshot.completeness).toContainEqual(
            expect.objectContaining({
              state: 'proven-stop',
              stopReason: 'declaration-context-boundary',
            }),
          );
        }
        if (mode === 'redirect-unavailable') {
          assertPathAdmission(
            adapter.snapshot,
            project.configPath,
            'unavailable',
          );
          assertPathAdmission(
            adapter.snapshot,
            fixture.path('tsconfig.ghost.json'),
            'admitted',
          );
        } else if (mode === 'root-uncovered')
          expect(adapter.snapshot.completeness).toContainEqual(
            expect.objectContaining({
              entryId: fixture.path('b.d.ts'),
              state: 'proven-stop',
              stopReason: 'uncovered',
            }),
          );
      } finally {
        await fixture.cleanup();
      }
    },
  );
});

function compilerWithoutReferenceMap(): typeof ts {
  const createProgram: typeof ts.createProgram = (...arguments_: unknown[]) => {
    const program = Reflect.apply(
      ts.createProgram,
      ts,
      arguments_,
    ) as ts.Program;
    return {
      ...program,
      getRedirectFromSourceFile: undefined,
      getProjectReferenceRedirect: undefined,
      getResolvedProjectReferenceToRedirect: undefined,
    };
  };
  return { ...ts, createProgram };
}

function assertPathAdmission(
  snapshot: NativeEvidenceSnapshot,
  candidate: string,
  state: 'unavailable' | 'denied' | 'admitted',
): void {
  const caches = createProjectDependencyCaches();
  const references = snapshot.obligations
    .filter(
      (obligation) =>
        obligation.consumerConfigId === candidate &&
        summarizeCompilationObligation(obligation) === 'required',
    )
    .map((obligation) => ({ from: candidate, to: obligation.targetConfigId! }));
  const configPaths = [
    ...new Set([candidate, ...references.map((pair) => pair.to)]),
  ];
  for (const configPath of configPaths)
    recordCoreWork(caches, {
      configPath,
      phase: 'locked',
      family: 'typescript',
      eligibility: 'eligible',
      execution: 'completed',
    });
  coreCollectionRun(caches).closed = true;
  const analysis: DependencyAnalysisResult = {
    complete: true,
    facts: [],
    diagnostics: [],
    // Isolate path-input admission with the final graph prerequisite satisfied.
    referenceValidation: { state: 'admitted', diagnostics: [] },
    candidate: { configPaths, references, schedules: [] },
  };
  // Endpoints alone do not bind a current Checker/config projection. A mixture
  // with required obligations is denied even while the raw unknown survives.
  const original = JSON.stringify(snapshot);
  retainNativeAnalysis(analysis, snapshot);
  finishAnalysisOutcome(analysis, caches, {
    scope: 'generated-graph',
    state: 'compliant',
    diagnostics: [],
  });
  expect(analysis.outcome!.execution).toBe('completed');
  expect(analysis.outcome!.buildAdmission.state).toBe(state);
  expect(JSON.stringify(snapshot)).toBe(original);
  if (state === 'denied')
    expect(analysis.outcome!.buildAdmission.reasons).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Unsatisfied compilation obligation:'),
      ]),
    );
}
