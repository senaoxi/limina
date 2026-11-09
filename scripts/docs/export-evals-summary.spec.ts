import assert from 'node:assert/strict';
import { it } from 'node:test';
import { contentIdentity } from './evals-public-protocol';
import { buildCurrentSummary } from './export-evals-summary';

type Source = Parameters<typeof buildCurrentSummary>[0];
type Latest = Parameters<typeof buildCurrentSummary>[1];
const digest = (n: number) => n.toString(16).padStart(64, '0');
function measured(ms: number): Latest['measurements'] {
  const known = {
    mean: ms,
    observedSum: 3 * ms,
    total: 3 * ms,
    measured: 3,
    executions: 3,
    coverage: 1,
    cells: 1,
    measuredCells: 1,
  };
  const unknown = {
    ...known,
    mean: null,
    observedSum: 0,
    total: null,
    measured: 0,
    coverage: 0,
    measuredCells: 0,
  };
  return {
    agentMs: known,
    endToEndMs: known,
    apiEquivalentUsd: unknown,
    settledUsd: unknown,
  };
}
function fixture() {
  const profile = {
    id: digest(1),
    model: 'gpt-6.1-terra',
    displayName: 'GPT 6.1 Terra (high)',
    reasoningEffort: 'high',
    serviceTier: 'default',
    codexVersion: '0.166.0',
  };
  const condition = (passed: number, ms: number) => ({
    passed,
    valid: 3,
    planned: 3,
    executions: 3,
    measurements: measured(ms),
  });
  const source: Source = {
    campaignId: digest(2),
    reportIdentity: digest(3),
    bankId: digest(4),
    sourceIndexDigest: digest(5),
    bankRevision: 'v2.1',
    stage: 'sealed',
    models: [
      {
        status: 'recorded',
        profile,
        report: {
          complete: true,
          planned: 24,
          executions: 24,
          tasks: [
            {
              id: 'P03',
              domain: 'package-release',
              role: 'main',
              fixtureIdentity: digest(6),
              gradingIdentity: digest(7),
              conditions: {
                base: condition(0, 1000),
                skill: condition(0, 9000),
              },
            },
            {
              id: 'C01',
              domain: 'configuration',
              role: 'main',
              fixtureIdentity: digest(8),
              gradingIdentity: digest(9),
              conditions: {
                base: condition(3, 2000),
                skill: condition(0, 4000),
              },
            },
            {
              id: 'C02',
              domain: 'configuration',
              role: 'main',
              fixtureIdentity: digest(10),
              gradingIdentity: digest(11),
              conditions: {
                base: condition(0, 5000),
                skill: condition(3, 6000),
              },
            },
            {
              id: 'N02',
              domain: 'negative-control',
              role: 'negative-control',
              fixtureIdentity: digest(12),
              gradingIdentity: digest(13),
              conditions: {
                base: condition(3, 100_000),
                skill: condition(3, 100_000),
              },
            },
          ],
        },
      },
    ],
  };
  const body = {
    schemaVersion: 1,
    kind: 'task-evaluation',
    scope: 'task-condition',
    includedInFormalScores: false,
    complete: true,
    bankId: digest(14),
    bankRevision: 'v2.1',
    campaignId: digest(15),
    experimentIdentity: digest(16),
    reportIdentity: digest(17),
    sourceIndexSha256: digest(18),
    taskId: 'P03',
    condition: 'skill',
    fixtureIdentity: digest(6),
    gradingIdentity: digest(7),
    executionIdentity: digest(19),
    profile,
    counts: { passed: 3, valid: 3, planned: 3, executions: 3 },
    measurements: measured(3000),
    repetitions: [1, 2, 3].map((repetition) => ({
      repetition,
      status: 'passed',
    })),
  } as const;
  const latest = {
    ...structuredClone(body),
    identity: contentIdentity(body),
  } as Latest;
  return { source, latest };
}
function references(source: Source, latest: Latest) {
  return {
    base: {
      file: `./evals-campaigns/${source.campaignId}-sealed-${source.reportIdentity}.json`,
      sha256: digest(20),
    },
    task: {
      file: `./evals-task-results/${latest.campaignId}-${latest.identity}.json`,
      sha256: digest(21),
    },
  };
}
function aggregate(source: Source, latest: Latest) {
  return buildCurrentSummary(
    source,
    latest,
    references(source, latest),
    digest(22),
  );
}
function sign(latest: Latest) {
  const { identity: _identity, ...body } = latest;
  latest.identity = contentIdentity(body);
}

it('aggregates the selected task once, preserving domain weights, controls, unknown costs and immutable sources', () => {
  const { source, latest } = fixture();
  const original = structuredClone({ source, latest });
  const result = aggregate(source, latest);
  assert.deepEqual(result.counts.base, {
    passed: 3,
    valid: 9,
    planned: 9,
    executions: 9,
  });
  assert.deepEqual(result.counts.skill, {
    passed: 6,
    valid: 9,
    planned: 9,
    executions: 9,
  });
  assert.equal(result.macro.base, 0.25);
  assert.equal(result.macro.skill, 0.75);
  assert.equal(result.differencePercentagePoints, 50);
  assert.equal(
    result.domains.find((domain) => domain.id === 'package-release')!.conditions
      .skill,
    1,
  );
  assert.equal(result.measurements.main.all.agentMs.mean, 3500);
  assert.equal(result.measurements.main.all.agentMs.executions, 18);
  assert.equal(result.measurements.negativeControls.all.agentMs.mean, 100_000);
  assert.equal(result.measurements.main.all.settledUsd.total, null);
  assert.equal(result.measurements.main.all.apiEquivalentUsd.mean, null);
  assert.equal(result.selectedExecutions, 24);
  assert.equal(result.sourceExecutions, 27);
  assert.equal(result.supersededExecutions, 3);
  assert.notEqual(result.sources.base.bankId, result.sources.task.bankId);
  assert.deepEqual({ source, latest }, original);
  // A worse complete latest result remains selected; this is not best-of-k.
  latest.counts.passed = 1;
  latest.repetitions[1]!.status = 'assertion_failed';
  latest.repetitions[2]!.status = 'agent_error';
  sign(latest);
  assert.equal(aggregate(source, latest).counts.skill!.passed, 4);
});

it('rejects mismatched models, grading, incomplete or inconsistent results and source identities without leaking extra fields', () => {
  const attacks: ((source: Source, latest: Latest) => void)[] = [
    (source) => {
      source.models[0]!.profile.id = digest(30);
    },
    (source) => {
      source.stage = 'smoke';
    },
    (source) => {
      source.bankRevision = 'v1';
    },
    (source) => {
      source.models[0]!.report!.complete = false;
    },
    (source) => {
      source.models[0]!.report!.tasks[0]!.gradingIdentity = digest(31);
    },
    (_source, latest) => {
      latest.counts.valid = 2;
    },
    (_source, latest) => {
      latest.repetitions[0]!.status = 'unknown';
    },
    (_source, latest) => {
      latest.repetitions[1]!.repetition = 1;
    },
    (_source, latest) => {
      latest.counts.passed = 2;
    },
  ];
  for (const attack of attacks) {
    const { source, latest } = fixture();
    attack(source, latest);
    sign(latest);
    assert.throws(() => aggregate(source, latest));
  }
  const { source, latest } = fixture();
  const before = aggregate(source, latest);
  Object.assign(source, { prompt: 'PRIVATE_PROMPT' });
  Object.assign(latest, { trace: '/fictional/private/trace' });
  sign(latest);
  assert.ok(!JSON.stringify(aggregate(source, latest)).includes('PRIVATE_'));
  assert.ok(!JSON.stringify(aggregate(source, latest)).includes('/fictional/'));
  assert.throws(() =>
    buildCurrentSummary(
      source,
      latest,
      {
        ...references(source, latest),
        base: { file: './wrong.json', sha256: digest(20) },
      },
      digest(22),
    ),
  );
  latest.identity = before.sources.task.identity;
  assert.throws(() => aggregate(source, latest), /identity/);
});
