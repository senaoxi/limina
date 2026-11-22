import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  intervalUnionUs,
  summarizeProfile,
} from '../application/analysis/observability-summary';
import type {
  CacheFact,
  GraphFields,
  WorkEnd,
  WorkRecord,
} from '../application/analysis/observability-types';

const empty: Parameters<typeof summarizeProfile>[0] = {
  work: [],
  graphs: [],
  projects: [],
  contexts: [],
  decisions: [],
  metrics: [],
  cachePolicy: 'read-write',
  inventoryComplete: false,
  dropped: 0,
};

function graph(
  id: string,
  source: 'computed' | 'restored',
): GraphFields & { id: string } {
  return {
    id,
    result: id,
    purpose: 'complete',
    source,
    producer: `${id}-producer`,
    prepared: [
      { gate: 'core', atUs: 30 },
      { gate: 'preflight', atUs: 34 },
    ],
  };
}

function producer(id: string, end: 'computed' | 'restored'): WorkRecord {
  return {
    id: `${id}-producer`,
    scope: ['graph', id],
    op: 'graph.prepare.core',
    end,
    time: [1, 30],
  };
}

describe('analysis observability evidence', () => {
  it('rejects contradictory cache decisions and ready/joined terminal records', () => {
    expectTypeOf<{
      stage: 'lookup';
      outcome: 'published';
    }>().not.toExtend<CacheFact>();
    expectTypeOf<{
      stage: 'publication';
      outcome: 'failed';
      causes: [];
    }>().not.toExtend<CacheFact>();
    expectTypeOf<{
      stage: 'admission';
      outcome: 'adopted';
      origin: 'prior-disk';
    }>().not.toExtend<CacheFact>();
    expectTypeOf<{
      stage: 'adoption';
      outcome: 'adopted';
    }>().not.toExtend<CacheFact>();
    expectTypeOf<{
      stage: 'publication';
      outcome: 'published';
      origin: 'unknown';
    }>().not.toExtend<CacheFact>();
    expectTypeOf<{
      end: 'shared';
      reuse: 'joined';
      time: [0, 10];
    }>().not.toExtend<WorkEnd>();
    expectTypeOf<{
      end: 'shared';
      reuse: 'ready';
      producer: { work: 'w' };
      atUs: 3;
      time: [0, 3];
    }>().not.toExtend<WorkEnd>();
    expectTypeOf<{
      end: 'shared';
      reuse: 'ready';
      producer: { work: 'w' };
      atUs: 3;
    }>().toExtend<WorkEnd>();
  });

  it('unions overlapping sibling intervals, keeping observer and shared wait out of execution attribution', () => {
    expect(
      intervalUnionUs([
        [9, 12],
        [2, 7],
        [6, 10],
        [14, 14],
        [20, 23],
      ]),
    ).toBe(13);
    const scope = ['context', 'ctx'] as const;
    const work: WorkRecord[] = [
      {
        id: 'parent',
        scope: ['project', 'p'],
        op: 'validation',
        end: 'performed',
        time: [0, 30],
      },
      {
        id: 'a',
        parent: 'parent',
        scope,
        op: 'native',
        end: 'computed',
        time: [1, 12],
      },
      {
        id: 'b',
        parent: 'parent',
        scope,
        op: 'native',
        end: 'computed',
        time: [8, 15],
      },
      {
        id: 'observer',
        parent: 'parent',
        scope,
        op: 'profile.sample',
        end: 'performed',
        time: [19, 21],
      },
      {
        id: 'join',
        parent: 'parent',
        scope,
        op: 'acquire',
        end: 'shared',
        reuse: 'joined',
        producer: { work: 'a' },
        time: [8, 17],
      },
      {
        id: 'ready',
        parent: 'parent',
        scope,
        op: 'acquire',
        end: 'shared',
        reuse: 'ready',
        producer: { work: 'a' },
        atUs: 25,
      },
    ];
    const result = summarizeProfile({
      ...empty,
      work,
      projects: [{ id: 'p', path: 'pkg/tsconfig.json' }],
      contexts: [
        {
          id: 'ctx',
          project: 'p',
          provider: 'native',
          providerRun: 'v',
          role: 'locked',
          checker: 'tsc',
        },
      ],
    });
    expect(result.projectRows[0]).toMatchObject({
      workUnionUs: 30,
      sharedWaitUs: 9,
    });
    expect(result.contextRows[0]).toMatchObject({
      workUnionUs: 14,
      sharedWaitUs: 9,
    });
    expect(result.workTimings[0]).toMatchObject({
      inclusiveUs: 30,
      exclusiveUs: 12,
    });
  });

  it('does not turn truncated or unmeasured work into zero', () => {
    const input = {
      ...empty,
      projects: [
        { id: 'p', path: 'tsconfig.json' },
        { id: 'q', path: 'q.json' },
      ],
      work: [
        {
          id: 'a',
          scope: ['project', 'p'],
          op: 'check',
          end: 'computed',
          time: [1, 7],
        },
      ] as WorkRecord[],
      dropped: 1,
    };
    const summary = summarizeProfile(input);
    expect(summary.projectRows[0]).toMatchObject({
      state: 'partial',
      workUnionUs: null,
      observedWorkUnionUs: 6,
    });
    expect(summary.projectRows[1]).toMatchObject({
      state: 'unavailable',
      workUnionUs: null,
    });
    expect(summary.workTimings[0]?.exclusiveUs).toBeNull();
    expect(summary.mode).toBe('unavailable');
  });

  it('preserves preparation gates, materialization and later ready delivery independently', () => {
    const result = graph('g', 'restored');
    const summary = summarizeProfile({
      ...empty,
      work: [
        producer('g', 'restored'),
        {
          id: 'apply',
          scope: ['graph', 'g'],
          op: 'graph.materialize',
          end: 'performed',
          time: [12, 41],
        },
        {
          id: 'retire',
          parent: 'apply',
          scope: ['graph', 'g'],
          op: 'graph.apply.artifacts',
          end: 'performed',
          time: [35, 37],
        },
        {
          id: 'apply-selected',
          parent: 'apply',
          scope: ['graph', 'g'],
          op: 'graph.apply.artifacts',
          end: 'performed',
          time: [39, 40],
        },
      ],
      graphs: [
        {
          ...result,
          applied: { work: 'apply', plan: 'p', atUs: 40 },
          receipt: { id: 's', slot: 'slot', view: 'view', atUs: 42 },
        },
        {
          id: 'g-core',
          purpose: 'complete',
          result: 'g',
          request: 'read',
          requestGate: 'core',
          requestAtUs: 10,
          deliveredAtUs: 31,
        },
        {
          id: 'g-read',
          purpose: 'complete',
          result: 'g',
          request: 'reused',
          requestGate: 'receipt',
          requestAtUs: 50,
          deliveredAtUs: 52,
        },
        {
          id: 'prod',
          purpose: 'producer-build',
          prepared: [{ gate: 'preflight', atUs: 2 }],
        },
      ],
    });
    expect(summary.firstCompleteGraphPrepared).toEqual({
      gate: 'core',
      atUs: 30,
    });
    expect(summary.firstCompleteReceiptCommittedUs).toBe(42);
    expect(summary.graphRows[0]?.artifactsApplyElapsedUs).toBe(3);
    expect(summary.graphRows[1]).toMatchObject({
      graphPrepareElapsedUs: 20,
      requestDeliveryUs: 21,
    });
    expect(summary.graphRows[2]).toMatchObject({
      graphPrepareElapsedUs: null,
      requestDeliveryUs: 2,
    });
    expect(
      summarizeProfile({ ...empty, graphs: [graph('read', 'computed')] })
        .firstCompleteReceiptCommittedUs,
    ).toBeNull();
  });

  it('classifies completed work from its own producer and upstream decisions', () => {
    const input: Parameters<typeof summarizeProfile>[0] = {
      ...empty,
      graphs: [graph('g', 'restored')],
      work: [producer('g', 'restored')],
      decisions: [
        {
          id: 'disk',
          work: 'command',
          layer: 'analysis-snapshot',
          stage: 'adoption',
          outcome: 'adopted',
          origin: 'prior-disk',
        },
        {
          id: 'hit',
          work: 'g-producer',
          layer: 'analysis-graph',
          stage: 'adoption',
          outcome: 'adopted',
          origin: 'prior-disk',
          basis: ['disk'],
        },
      ],
    };
    expect(summarizeProfile(input).mode).toBe('warm');
    expect(
      summarizeProfile({ ...input, decisions: [input.decisions[0]!] }).mode,
    ).toBe('unavailable');
    const incremental: typeof input = {
      ...input,
      graphs: [graph('g', 'computed')],
      work: [producer('g', 'computed')],
      decisions: [
        input.decisions[0]!,
        {
          id: 'miss',
          work: 'g-producer',
          layer: 'analysis-graph',
          stage: 'admission',
          outcome: 'rejected',
          causes: [{ code: 'changed' }],
          basis: ['disk'],
        },
      ],
    };
    expect(summarizeProfile(incremental).mode).toBe('incremental');
    expect(
      summarizeProfile({
        ...incremental,
        graphs: [...incremental.graphs, graph('h', 'restored')],
        work: [...incremental.work, producer('h', 'restored')],
        decisions: [
          ...incremental.decisions,
          {
            id: 'hit',
            work: 'h-producer',
            layer: 'analysis-graph',
            stage: 'adoption',
            outcome: 'adopted',
            origin: 'prior-disk',
            basis: ['disk'],
          },
        ],
      }).mode,
    ).toBe('mixed');
    expect(
      summarizeProfile({
        ...incremental,
        decisions: [
          {
            id: 'empty',
            work: 'command',
            layer: 'analysis-snapshot',
            stage: 'lookup',
            outcome: 'absent',
            causes: [{ code: 'no-index' }],
          },
        ],
      }).mode,
    ).toBe('cold');
    expect(summarizeProfile(empty).mode).toBe('not-applicable');
  });

  it('classifies managed graph bypass from the exact context it consumes', () => {
    const disk = {
      id: 'disk',
      work: 'command',
      layer: 'analysis-snapshot',
      stage: 'adoption',
      outcome: 'adopted',
      origin: 'prior-disk',
    } as const;
    const skip = {
      id: 'skip',
      work: 'g-producer',
      layer: 'analysis-graph',
      stage: 'admission',
      outcome: 'bypassed',
      causes: [{ code: 'producer-build-plan' }],
      basis: ['disk'],
    } as const;
    const prior = {
      ...disk,
      id: 'earlier-context',
      work: 'routing',
      layer: 'native-context',
      subject: 'tsconfig.json',
      basis: ['disk'],
    };
    const reuse = {
      ...prior,
      id: 'context-use',
      work: 'g-producer',
      origin: 'invocation-memory',
      basis: undefined,
    } as const;
    const input = {
      ...empty,
      graphs: [{ ...graph('g', 'computed'), purpose: 'producer-build' }],
      work: [
        {
          id: 'command',
          op: 'command',
          scope: ['invocation'],
          end: 'performed',
          time: [0, 35],
        },
        {
          id: 'routing',
          parent: 'command',
          op: 'checker-ownership-discovery',
          scope: ['invocation'],
          end: 'performed',
          time: [1, 4],
        },
        { ...producer('g', 'computed'), parent: 'command' },
      ],
      decisions: [disk, skip, prior],
    } satisfies Parameters<typeof summarizeProfile>[0];
    expect(
      summarizeProfile({ ...input, decisions: [...input.decisions, reuse] })
        .graphModes,
    ).toMatchObject([{ mode: 'unavailable', basis: ['skip', 'g-producer'] }]);

    const scoped = summarizeProfile({
      ...input,
      decisions: [...input.decisions, { ...reuse, basis: [prior.id] }],
    });
    expect(scoped.mode).toBe('incremental');
    expect(scoped.graphModes).toMatchObject([
      { mode: 'incremental', basis: ['skip', 'g-producer', 'context-use'] },
    ]);

    const absent = {
      id: 'empty',
      work: 'command',
      layer: 'analysis-snapshot',
      stage: 'lookup',
      outcome: 'absent',
      causes: [{ code: 'no-index' }],
    } as const;
    expect(
      summarizeProfile({
        ...input,
        decisions: [disk, prior, absent, { ...skip, basis: [absent.id] }],
      }).mode,
    ).toBe('cold');
    for (const cachePolicy of ['forced', 'disabled'])
      expect(
        summarizeProfile({
          ...input,
          cachePolicy,
          decisions: [{ ...skip, basis: undefined }],
        }).mode,
      ).toBe('cold');
  });

  it('only exposes an outer complete graph once its requested gate succeeds', () => {
    const core = graph('g', 'computed');
    core.prepared = [{ gate: 'core', atUs: 30 }];
    const base = {
      ...empty,
      graphs: [
        core,
        {
          id: 'read',
          purpose: 'complete',
          request: 'request',
          requestGate: 'preflight',
        },
      ],
      work: [
        { ...producer('g', 'computed'), parent: 'request' },
        {
          id: 'request',
          scope: ['graph', 'read'],
          op: 'graph.request',
          end: 'failed',
          time: [0, 31],
          reason: 'input-drift',
        },
      ],
    } satisfies Parameters<typeof summarizeProfile>[0];
    const summary = summarizeProfile(base);
    expect(summary.firstCompleteGraphPrepared).toBeNull();
    expect(summary.graphRows[0]?.prepared).toEqual({ gate: 'core', atUs: 30 });
  });

  it('retains failed program passes and measured zero for a skipped operation', () => {
    const scope = ['project', 'p'] as const;
    const result = summarizeProfile({
      ...empty,
      projects: [{ id: 'p', path: 'a.json' }],
      work: [
        {
          id: 'a',
          scope,
          op: 'native-program-create',
          end: 'performed',
          time: [1, 3],
          pass: 1,
        },
        {
          id: 'b',
          scope,
          op: 'native-program-create',
          end: 'failed',
          time: [4, 5],
          reason: 'compile',
          pass: 2,
        },
        {
          id: 's',
          scope,
          op: 'vue-program-create',
          end: 'not-run',
          reason: 'excluded',
        },
      ],
    });
    expect(result.projectRows[0]?.programs).toEqual([
      {
        op: 'native-program-create',
        attempts: 2,
        created: 1,
        failed: 1,
        pending: 0,
        passes: [1, 2],
      },
      {
        op: 'vue-program-create',
        attempts: 0,
        created: 0,
        failed: 0,
        pending: 0,
        passes: [],
      },
    ]);
  });
  it('keeps a terminal context failure at project level and separates a successful retry', () => {
    const input: Parameters<typeof summarizeProfile>[0] = {
      ...empty,
      projects: [{ id: 'p', path: 'tsconfig.json' }],
      contexts: ['a', 'b'].map((id) => ({
        id,
        project: 'p',
        providerRun: 'v',
        provider: 'native',
        checker: 'tsc',
        role: 'locked',
      })),
      work: [
        {
          id: 'old',
          scope: ['context', 'a'],
          op: 'semantic',
          end: 'failed',
          time: [1, 4],
          reason: 'drift',
        },
        {
          id: 'ok',
          scope: ['context', 'b'],
          op: 'semantic',
          end: 'computed',
          time: [4, 7],
        },
      ],
    };
    const failed = summarizeProfile(input);
    expect(failed.projectRows[0]).toMatchObject({
      state: 'failed',
      failedAttempts: 1,
      workUnionUs: 6,
    });
    expect(failed.contextRows.map((row) => row.state)).toEqual([
      'failed',
      'rebuilt',
    ]);
    const retried = summarizeProfile({
      ...input,
      links: [{ kind: 'retry-of', from: 'ok', to: 'old' }],
    });
    expect(retried.projectRows[0]).toMatchObject({
      state: 'rebuilt',
      failedAttempts: 1,
      workUnionUs: 6,
    });
    expect(retried.contextRows.map((row) => row.state)).toEqual([
      'failed',
      'rebuilt',
    ]);
  });

  it('distinguishes an observed failed wait from a graph join without a resume', () => {
    const input: Parameters<typeof summarizeProfile>[0] = {
      ...empty,
      projects: [{ id: 'p', path: 'tsconfig.json' }],
      contexts: [
        {
          id: 'c',
          project: 'p',
          providerRun: 'v',
          checker: 'tsc',
          provider: 'native',
          role: 'locked',
        },
      ],
      work: [
        {
          id: 'producer',
          scope: ['graph', 'g'],
          op: 'prepare',
          end: 'failed',
          time: [3, 9],
          reason: 'invalid',
        },
        {
          id: 'wait',
          scope: ['context', 'c'],
          op: 'graph.wait.preparation',
          end: 'failed',
          time: [4, 10],
          reason: 'shared-producer-failed',
        },
        {
          id: 'forward',
          parent: 'wait',
          scope: ['graph', 'request'],
          op: 'graph.request',
          end: 'performed',
          time: [4, 6],
        },
      ],
      links: [{ kind: 'waits-for', from: 'wait', to: 'producer' }],
    };
    expect(summarizeProfile(input).projectRows[0]).toMatchObject({
      workUnionUs: 0,
      sharedWaitUs: 6,
    });
    const incomplete = summarizeProfile({
      ...input,
      links: [
        ...input.links!,
        { kind: 'waits-for', from: 'forward', to: 'producer' },
      ],
    });
    expect(incomplete.contextRows[0]).toMatchObject({
      workUnionUs: 0,
      sharedWaitUs: null,
    });
    expect(incomplete.projectRows[0]).toMatchObject({
      workUnionUs: 0,
      sharedWaitUs: null,
    });
  });
});
