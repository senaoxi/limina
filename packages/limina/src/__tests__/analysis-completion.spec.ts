import { describe, expect, it } from 'vitest';
import {
  candidateAdmission,
  type CandidateBuildPlan,
} from '../core/build-graph/analysis-admission';
import { retainAnalysisFailure } from '../core/build-graph/analysis-failure';
import { finishAnalysisOutcome } from '../core/build-graph/analysis-outcome';
import {
  bindCurrentCompilationContexts,
  bindExecutionCompilationProjection,
  projections,
} from '../core/build-graph/compilation-projection';
import {
  beginCoreCollection,
  coreCollectionRun,
  recordCoreWork,
} from '../core/build-graph/core-collection-run';
import { retainNativeAnalysis } from '../core/build-graph/native-analysis-evidence';
import { analyzeProjectDependencies } from '../core/build-graph/prepare';
import type { DependencyAnalysisResult } from '../core/build-graph/types';
import { createProjectDependencyCaches } from '../core/project-dependencies/cache';
import { createNativeDependencyContext } from '../core/typescript-semantic/native-context-factory';
import { createWorkspaceSourceBoundary } from '../core/typescript-semantic/workspace-source-boundary';
import {
  type CoreWorkItem,
  summarizeCoreCollection,
} from '../domain/analysis/core-collection';
import { summarizeCompilationObligation } from '../domain/analysis/native-obligation';
import { createLiminaArtifactNamespace } from '../domain/artifacts/namespace';
import { withFixtureGovernanceRoot } from './helpers/governance-root';
import { createSemanticRepairFixture } from './helpers/semantic-repair';

const item: CoreWorkItem = {
  id: 'a',
  configPath: 'A',
  phase: 'locked',
  family: 'typescript',
  eligibility: 'eligible',
  execution: 'completed',
};
const governance = {
  scope: 'generated-graph' as const,
  state: 'compliant' as const,
  diagnostics: [],
};
const transaction = { state: 'not-requested' as const, failures: [] };
const analysis = (): DependencyAnalysisResult => ({
  complete: true,
  diagnostics: [],
  facts: [],
  candidate: { configPaths: ['A'], references: [], schedules: [] },
});

describe('Core scheduling and candidate admission', () => {
  it('completes all eligible work with an unavailable independent authority', () => {
    const core = summarizeCoreCollection({
      closed: true,
      entries: [
        item,
        {
          ...item,
          id: 'b',
          configPath: 'B',
          eligibility: 'unavailable',
          execution: 'not-run',
        },
      ],
      executionFailureIds: [],
    });
    expect(core.dispatch).toBe('completed');
    expect(
      candidateAdmission(analysis(), {
        core,
        governance,
        graphTransaction: transaction,
      }).state,
    ).toBe('admitted');
    const needsB = analysis();
    needsB.candidate = {
      configPaths: ['A', 'B'],
      references: [],
      schedules: [],
    };
    expect(
      candidateAdmission(needsB, {
        core,
        governance,
        graphTransaction: transaction,
      }).state,
    ).toBe('unavailable');
  });
  it('cannot claim complete when governance skips an eligible entry', () => {
    const core = summarizeCoreCollection({
      closed: true,
      entries: [{ ...item, execution: 'not-run' }],
      executionFailureIds: [],
    });
    expect(core.dispatch).toBe('incomplete');
    expect(
      candidateAdmission(analysis(), {
        core,
        governance,
        graphTransaction: transaction,
      }).state,
    ).toBe('unavailable');
  });
  it('does not admit an omitted candidate prerequisite', () => {
    const core = summarizeCoreCollection({
      closed: true,
      entries: [],
      executionFailureIds: [],
    });
    expect(
      candidateAdmission(analysis(), {
        core,
        governance,
        graphTransaction: transaction,
      }).state,
    ).toBe('unavailable');
  });
  it('keeps completed Core immutable when the post-collection transaction fails', () => {
    const caches = createProjectDependencyCaches();
    recordCoreWork(caches, item);
    coreCollectionRun(caches).closed = true;
    const result = analysis();
    finishAnalysisOutcome(result, caches, governance);
    const core = structuredClone(result.outcome!.core);
    retainAnalysisFailure(caches, new Error('output projection failed'));
    finishAnalysisOutcome(result, caches, governance);
    expect(result.outcome!.core).toEqual(core);
    expect(result.outcome!.execution).toBe('completed');
    expect(result.outcome!.graphTransaction.state).toBe('failed');
    expect(result.outcome!.buildAdmission.state).toBe('unavailable');
  });
  it('reports an actual Core failure independently of a drained worklist', () => {
    const caches = createProjectDependencyCaches();
    recordCoreWork(caches, { ...item, execution: 'failed' });
    retainAnalysisFailure(caches, new Error('compiler failed'), 'A');
    coreCollectionRun(caches).closed = true;
    const result = analysis();
    finishAnalysisOutcome(result, caches, governance);
    expect(result.outcome!.core.dispatch).toBe('completed');
    expect(result.outcome!.execution).toBe('failed');
    expect(result.outcome!.buildAdmission.state).toBe('unavailable');
  });
});

it('starts a fresh execution ledger when dependency caches are reused', () => {
  const caches = createProjectDependencyCaches();
  coreCollectionRun(caches).closed = true;
  beginCoreCollection(caches);
  retainAnalysisFailure(caches, new Error('new compiler failure'), 'A');
  expect(coreCollectionRun(caches).failureIds.size).toBe(1);
  expect(coreCollectionRun(caches).transactionFailures).toEqual([]);
});

it('retains a usable candidate outside an actual failure scope', () => {
  const caches = createProjectDependencyCaches();
  recordCoreWork(caches, item);
  recordCoreWork(caches, { ...item, configPath: 'B', execution: 'failed' });
  retainAnalysisFailure(caches, new Error('B compiler failed'), 'B');
  coreCollectionRun(caches).closed = true;
  const result = analysis();
  finishAnalysisOutcome(result, caches, governance);
  expect(result.outcome!.execution).toBe('partial');
  expect(result.outcome!.core.dispatch).toBe('completed');
  expect(result.outcome!.buildAdmission.state).toBe('admitted');
});

it.each([
  { noResolve: false, hasRawReference: false, json: false },
  { noResolve: true, hasRawReference: false, json: false },
  { noResolve: false, hasRawReference: true, json: false },
  { noResolve: false, hasRawReference: false, json: true },
])(
  'rebinds Native declaration prerequisites (noResolve=$noResolve, rawReference=$hasRawReference, json=$json)',
  async ({ noResolve, hasRawReference, json }) => {
    const fixture = await createSemanticRepairFixture({
      'package.json': JSON.stringify({
        name: 'admission-contract',
        private: true,
        type: 'module',
      }),
      'pnpm-workspace.yaml': 'packages:\n  - .\n',
      'limina.config.mjs': 'export default {};',
      'tsconfig.json': JSON.stringify({
        files: [],
        references: [
          { path: './tsconfig.a.json' },
          { path: './tsconfig.b.json' },
        ],
      }),
      'tsconfig.a.json': JSON.stringify({
        compilerOptions: {
          module: 'NodeNext',
          types: [],
          noEmit: true,
          noResolve,
          resolveJsonModule: json,
        },
        files: ['a.ts'],
        liminaOptions: {
          implicitRefs: [
            {
              path: './tsconfig.b.json',
              reason: 'explicit candidate relation',
            },
          ],
        },
      }),
      'tsconfig.b.json': JSON.stringify({
        compilerOptions: { module: 'NodeNext', types: [], noEmit: true },
        files: [json ? 'b.json' : 'b.ts'],
      }),
      'a.ts': json
        ? 'import b from "./b.json"; export const a = b;'
        : 'import { b } from "./b.js"; export const a = b;',
      'b.json': '{"b":1}',
      'b.ts': 'export const b = 1;',
    });
    try {
      const config = withFixtureGovernanceRoot({
        rootDir: fixture.root,
        configPath: fixture.path('limina.config.mjs'),
        scope: { checkers: { tsc: { include: ['tsconfig.json'] } } },
      });
      const evidence = await analyzeProjectDependencies(config, {
        artifactNamespace: createLiminaArtifactNamespace({
          rootDir: fixture.root,
          generation: 0,
        }),
      });
      if (hasRawReference) bindSatisfiedNativeContext(evidence, fixture);
      const original = JSON.stringify(evidence.nativeEvidence);
      const pair = {
        from: fixture.path('tsconfig.a.json'),
        to: fixture.path('tsconfig.b.json'),
      };
      const assess = (
        references: (typeof pair)[],
        schedules: (typeof pair)[],
      ) =>
        candidateAdmission(
          {
            ...evidence,
            candidate: Object.assign(evidence.candidate!, {
              references,
              schedules,
            }),
          },
          evidence.outcome!,
        ).state;
      expect(assess([pair], [])).toBe('admitted');
      const expectedSummary = noResolve
        ? 'not-required'
        : json
          ? 'unknown'
          : hasRawReference
            ? 'already-satisfied'
            : 'required';
      const locked = evidence.nativeEvidence!.flatMap(({ snapshot }) =>
        snapshot.obligations.filter((obligation) =>
          snapshot.contexts.some(
            (context) =>
              context.id === obligation.consumerContextId &&
              context.authority.phase === 'locked',
          ),
        ),
      );
      expect(
        locked.some(
          (obligation) =>
            obligation.consumerConfigId === pair.from &&
            summarizeCompilationObligation(obligation) === expectedSummary,
        ),
      ).toBe(true);
      if (!noResolve) assertRelationIdentity(evidence, pair);

      const missing = noResolve ? 'admitted' : json ? 'unavailable' : 'denied';
      expect(assess([], [pair])).toBe(missing);
      expect(assess([], [])).toBe(missing);
      expect(JSON.stringify(evidence.nativeEvidence)).toBe(original);
      expect(
        candidateAdmission(
          {
            ...evidence,
            candidate: {
              configPaths: [pair.to],
              references: [],
              schedules: [],
            },
          },
          evidence.outcome!,
        ).state,
      ).toBe('admitted');
    } finally {
      await fixture.cleanup();
    }
  },
);

function bindSatisfiedNativeContext(
  evidence: DependencyAnalysisResult,
  fixture: Awaited<ReturnType<typeof createSemanticRepairFixture>>,
): void {
  // The public source-config reader rejects handwritten references. Exercise
  // the internal admission contract with a real referenced Native Program.
  const configPath = fixture.path('tsconfig.a.json');
  const parsed = fixture.parse('tsconfig.a.json');
  const coverage = evidence.nativeEvidence!.flatMap(
    ({ snapshot }) => snapshot.coverageIndexes,
  )[0]!;
  const context = createNativeDependencyContext({
    configPath,
    fileNames: parsed.fileNames,
    options: { ...parsed.options, composite: true },
    projectReferences: [{ path: fixture.path('tsconfig.b.json') }],
    compilationObligationScope: 'generated-declaration-project-v1',
    analysisBinding: { phase: 'locked', checker: 'tsc' },
    workspaceSourceBoundary: createWorkspaceSourceBoundary(
      parsed.fileNames,
      undefined,
      coverage,
    ),
  });
  try {
    const current = projections.get(evidence.candidate!)!.contexts;
    const snapshot = context.nativeEvidence!;
    expect(
      snapshot.obligations.some(
        (obligation) =>
          summarizeCompilationObligation(obligation) === 'already-satisfied',
      ),
    ).toBe(true);
    evidence.nativeEvidence = evidence.nativeEvidence!.filter(
      ({ snapshot: original }) =>
        original.contexts.every((item) => item.inputs.config !== configPath),
    );
    retainNativeAnalysis(evidence, snapshot);
    bindCurrentCompilationContexts(evidence.candidate, [
      ...current.filter((item) => item.inputs.config !== configPath),
      ...snapshot.contexts,
    ]);
  } finally {
    context.dispose();
  }
}

function assertRelationIdentity(
  evidence: DependencyAnalysisResult,
  pair: { from: string; to: string },
): void {
  const original = evidence.candidate!;
  const projection = projections.get(original)!;
  const source = projection.sources.find(
    (unit) => unit.configPath === pair.from,
  )!;
  const provider = projection.sources.find(
    (unit) => unit.configPath === pair.to,
  )!;
  if (
    !('dtsConfigPath' in source.buildProjection) ||
    !('dtsConfigPath' in provider.buildProjection)
  )
    throw new Error('Expected real declaration projection');
  const reference = {
    kind: 'declaration',
    from: {
      sourceConfigPath: pair.from,
      checkerName: source.primaryCheckerName,
    },
    to: { sourceConfigPath: pair.to, checkerName: provider.primaryCheckerName },
    fromConfigPath: source.buildProjection.dtsConfigPath,
    toConfigPath: provider.buildProjection.dtsConfigPath,
  };
  const assess = (candidate: CandidateBuildPlan) =>
    candidateAdmission({ ...evidence, candidate }, evidence.outcome!).state;
  const serialized = JSON.stringify(original);
  expect(assess(JSON.parse(serialized))).not.toBe('admitted');
  for (const replacement of [
    reference,
    { ...reference, kind: 'framework-schedule' },
    { ...reference, to: { ...reference.to, checkerName: 'wrong-checker' } },
    { ...reference, toConfigPath: source.buildProjection.dtsConfigPath },
  ]) {
    const candidate = { ...original, references: [pair], schedules: [pair] };
    bindExecutionCompilationProjection(original, candidate, {
      sources: projection.sources,
      references: [replacement],
      consumers: [reference.from],
    });
    expect(assess(candidate) === 'admitted').toBe(replacement === reference);
  }
  const current = projection.contexts;
  bindCurrentCompilationContexts(
    original,
    current.map((context) => ({
      ...context,
      epoch: `${context.epoch}-replaced`,
    })),
  );
  expect(assess(original)).not.toBe('admitted');
  bindCurrentCompilationContexts(original, current);
  expect(assess(original)).toBe('admitted');
}
