import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import {
  AnalysisObserver,
  currentProfile,
  runWithProfile,
} from '../application/analysis/observability';

test('overlapping invocations keep identical project paths and provider objects local to the consuming command', async () => {
  const gate = Promise.withResolvers<void>();
  const shared = {};
  async function observe(name: string, shouldFail: boolean) {
    const observer = new AnalysisObserver('limina check', performance.now());
    observer.setRoot(path.join(os.tmpdir(), name));
    return runWithProfile(observer, async () => {
      const owner = observer.provider(shared, 0, 0, 'initial');
      const project = observer.project(
        path.join(observer.root!, 'app', 'tsconfig.json'),
      );
      const local = observer.context(
        shared,
        project,
        owner,
        'tsc',
        'native',
        'locked',
      );
      const id = observer.start('native-closure', ['context', local]);
      await observer.withProviderRun(owner, () =>
        observer.inWork(id, async () => {
          await gate.promise;
          expect(currentProfile()).toBe(observer);
          expect(observer.currentWork).toBe(id);
          expect(observer.currentProviderRun()).toBe(owner);
          observer.metric(
            'native.bounded.attempts',
            observer.currentScope,
            'calls',
            shouldFail ? 2 : 1,
          );
        }),
      );
      observer.finish(id, shouldFail ? 'failed' : 'computed');
      observer.stop(!shouldFail);
      return observer.snapshot();
    });
  }
  const first = observe('first-workspace', false);
  const second = observe('second-workspace', true);
  gate.resolve();
  const [a, b] = await Promise.all([first, second]);
  expect(currentProfile()).toBeUndefined();
  expect(a.invocation.id).not.toBe(b.invocation.id);
  expect(a.projects[0]?.path).toBe('app/tsconfig.json');
  expect(a.metrics[0]?.value).toBe(1);
  expect(b.metrics[0]?.value).toBe(2);
  expect(a.summary.projectRows[0]?.state).toBe('rebuilt');
  expect(b.summary.projectRows[0]?.state).toBe('failed');
});

test.each([
  'native-resolution',
  'native-source-syntax',
  'resolved-config',
  'resolved-config-live-parse',
])(
  '%s query sampling preserves counts and a later authoritative publication',
  (layer) => {
    const profile = new AnalysisObserver('limina check', performance.now());
    for (let index = 0; index < 3000; index++)
      profile.decision(layer, {
        stage: 'lookup',
        outcome: 'found',
      });
    profile.decision('analysis-snapshot', {
      stage: 'publication',
      outcome: 'published',
    });
    profile.stop(true);
    const { metrics, decisions, coverage } = profile.snapshot();
    expect(metrics).toContainEqual({
      key: `cache.${layer}.lookup.found`,
      scope: ['invocation'],
      kind: 'counter',
      unit: 'calls',
      value: 3000,
    });
    const retained = decisions.filter((decision) => decision.layer === layer);
    expect(retained.length).toBeLessThan(3000);
    expect(coverage.detailsOmitted + retained.length).toBe(3000);
    expect(decisions.at(-1)).toMatchObject({
      stage: 'publication',
      outcome: 'published',
    });
  },
);

test('retains only resolvable work references at the detail limit', () => {
  const profile = new AnalysisObserver('limina check', performance.now());
  const root = profile.currentWork;
  const retained = profile.start('graph.prepare', ['graph', 'graph']);
  profile.finish(retained);
  for (let index = 2; index < 50_000; index++)
    profile.notRun('sample', ['invocation'], 'unrequested');

  const omitted = profile.start('analysis', ['graph', 'graph']);
  profile.link('uses-result', retained, omitted);
  profile.link('waits-for', omitted, retained);
  profile.link('uses-result', root, retained);
  const missingDecision = profile.decision(
    'analysis-graph',
    { stage: 'lookup', outcome: 'found' },
    undefined,
    omitted,
  );
  const publication = profile.decision(
    'analysis-snapshot',
    { stage: 'publication', outcome: 'published', basis: [missingDecision] },
    undefined,
    retained,
  );
  profile.graph('graph', {
    request: retained,
    producer: retained,
    applied: { work: retained, plan: 'old', atUs: 1 },
  });
  profile.graph('graph', {
    request: omitted,
    producer: omitted,
    applied: { work: omitted, plan: 'new', atUs: 2 },
    plan: 'new',
    prepared: [{ gate: 'core', atUs: 2 }],
    receipt: { id: 'receipt', slot: 'slot', view: 'view', atUs: 3 },
  });
  profile.graph('other', {
    request: retained,
    producer: retained,
    applied: { work: retained, plan: 'other', atUs: 1 },
  });
  profile.stop(true);
  const result = profile.snapshot();
  expect(result.work).toHaveLength(50_000);
  expect(result.links).toEqual([
    { kind: 'uses-result', from: root, to: retained },
  ]);
  expect(result.decisions).toMatchObject([
    { id: publication, work: retained, basis: [] },
  ]);
  expect(result.graphs[0]).toEqual({
    id: 'graph',
    plan: 'new',
    prepared: [{ gate: 'core', atUs: 2 }],
    receipt: { id: 'receipt', slot: 'slot', view: 'view', atUs: 3 },
  });
  expect(result.graphs[1]).toMatchObject({
    request: retained,
    producer: retained,
    applied: { work: retained },
  });
  expect(result.coverage.detailsOmitted).toBeGreaterThan(0);
});
