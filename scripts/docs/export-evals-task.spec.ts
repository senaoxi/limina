import assert from 'node:assert/strict';
import { it } from 'node:test';
import { publicTaskResult } from './export-evals-task';

type Source = Parameters<typeof publicTaskResult>[0];
const digest = (n: number) => n.toString(16).padStart(64, '0');
function fixture(): Source {
  const duration = {
    mean: 2000,
    observedSum: 6000,
    total: 6000,
    measured: 3,
    executions: 3,
    coverage: 1,
    cells: 1,
    measuredCells: 1,
  };
  const unknown = {
    mean: null,
    observedSum: 0,
    total: null,
    measured: 0,
    executions: 3,
    coverage: 0,
    cells: 1,
    measuredCells: 0,
  };
  return {
    schemaVersion: 2,
    campaignId: digest(1),
    reportIdentity: digest(2),
    bankId: digest(3),
    bankRevision: 'v2.1',
    stage: 'sealed',
    models: [
      {
        status: 'recorded',
        profile: {
          id: digest(4),
          model: 'gpt-6.1-terra',
          displayName: 'GPT 6.1 Terra (high)',
          reasoningEffort: 'high',
          serviceTier: 'default',
          codexVersion: '0.166.0',
        },
        report: {
          experimentIdentity: digest(5),
          planned: 54,
          executions: 3,
          tasks: [
            {
              id: 'P03',
              fixtureIdentity: digest(6),
              gradingIdentity: digest(7),
              executionIdentity: digest(8),
              conditions: {
                skill: {
                  passed: 2,
                  valid: 3,
                  planned: 3,
                  executions: 3,
                  coverage: 1,
                  measurements: {
                    agentMs: { ...duration },
                    endToEndMs: { ...duration },
                    apiEquivalentUsd: { ...unknown },
                    settledUsd: { ...unknown },
                  },
                  repetitions: ['passed', 'assertion_failed', 'passed'].map(
                    (status, index) => ({
                      repetition: index + 1,
                      status,
                      attemptCount: 1,
                      attempts: [
                        { id: digest(20 + index), ordinal: 1, status },
                      ],
                    }),
                  ),
                },
              },
            },
          ],
        },
      },
    ],
  };
}

it('publishes a complete one-task result with failures and unknown costs, without private fields or a bank-wide score', () => {
  const source = fixture();
  const before = structuredClone(source);
  Object.assign(source, {
    prompt: 'PRIVATE_PROMPT',
    trace: '/fictional/private/trace',
  });
  Object.assign(source.models[0]!.profile, { account: 'PRIVATE_ACCOUNT' });
  Object.assign(
    source.models[0]!.report!.tasks[0]!.conditions.skill!.measurements.agentMs,
    { path: 'PRIVATE_PATH' },
  );
  const result = publicTaskResult(source, digest(30));
  assert.equal(result.kind, 'task-evaluation');
  assert.equal(result.includedInFormalScores, false);
  assert.deepEqual(result.counts, {
    passed: 2,
    valid: 3,
    planned: 3,
    executions: 3,
  });
  assert.deepEqual(
    result.repetitions.map((r) => r.status),
    ['passed', 'assertion_failed', 'passed'],
  );
  assert.equal(result.measurements.settledUsd.mean, null);
  assert.equal(result.measurements.apiEquivalentUsd.mean, null);
  assert.equal(result.profile.id, before.models[0]!.profile.id);
  assert.equal(result.bankId, before.bankId);
  assert.equal(result.schemaVersion, 1);
  assert.equal(Object.hasOwn(result.measurements, 'inputTokens'), false);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|fictional|macro|lift/u);
});

it('exports input token coverage separately from pricing and strips private token evidence', () => {
  const source = fixture();
  const m = source.models[0]!.report!.tasks[0]!.conditions.skill!.measurements;
  m.inputTokens = {
    ...m.agentMs,
    mean: 1200,
    observedSum: 2900,
    total: null,
    measured: 2,
    coverage: 2 / 3,
  };
  Object.assign(m.inputTokens, { trace: 'PRIVATE_TOKEN_TRACE' });
  const result = publicTaskResult(source, digest(30));
  assert.equal(result.schemaVersion, 2);
  assert.equal(result.measurements.inputTokens!.mean, 1200);
  assert.equal(result.measurements.inputTokens!.measured, 2);
  assert.equal(result.measurements.inputTokens!.total, null);
  assert.equal(result.measurements.apiEquivalentUsd.mean, null);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_TOKEN_TRACE/u);
});

it('publishes the explicitly selected development I03 result without treating its unrun batch slots as executions', () => {
  const source = fixture();
  source.stage = 'development';
  source.models[0]!.report!.planned = 102;
  source.models[0]!.report!.tasks[0]!.id = 'I03';
  const before = structuredClone(source);
  const result = publicTaskResult(source, digest(30), { taskId: 'I03' });
  assert.equal(result.schemaVersion, 3);
  assert.equal(result.stage, 'development');
  assert.equal(result.taskId, 'I03');
  assert.equal(result.experimentIdentity, digest(5));
  assert.equal(result.bankId, digest(3));
  assert.equal(result.counts.executions, 3);
  assert.equal(result.counts.passed, 2);
  assert.equal(result.includedInFormalScores, false);
  assert.deepEqual(source, before);
  assert.throws(() => publicTaskResult(source, digest(30)));
  source.stage = 'sealed';
  assert.throws(() => publicTaskResult(source, digest(30), { taskId: 'I03' }));
});

it('rejects unresolved, missing, duplicated, replacement or foreign-condition samples and miscounted results', () => {
  const mutations: ((s: Source) => void)[] = [
    (s) => {
      s.models[0]!.status = 'not_admitted';
    },
    (s) => {
      s.models[0]!.report!.executions = 54;
    },
    (s) => {
      s.models[0]!.report!.tasks[0]!.id = 'I03';
    },
    (s) => {
      s.models[0]!.report!.tasks[0]!.conditions.skill!.valid = 2;
    },
    (s) => {
      s.models[0]!.report!.tasks[0]!.conditions.skill!.passed = 3;
    },
    (s) => {
      s.models[0]!.report!.tasks[0]!.conditions.skill!.repetitions.pop();
    },
    (s) => {
      s.models[0]!.report!.tasks[0]!.conditions.skill!.repetitions[1]!.repetition = 1;
    },
    (s) => {
      s.models[0]!.report!.tasks[0]!.conditions.skill!.repetitions[1]!.attempts[0]!.id =
        digest(20);
    },
    (s) => {
      s.models[0]!.report!.tasks[0]!.conditions.skill!.repetitions[1]!.attempts[0]!.ordinal = 2;
    },
    (s) => {
      const run =
        s.models[0]!.report!.tasks[0]!.conditions.skill!.repetitions[1]!;
      run.status = 'unknown';
      run.attempts[0]!.status = 'unknown';
    },
    (s) => {
      const task = s.models[0]!.report!.tasks[0]!;
      task.conditions.base = task.conditions.skill!;
      delete task.conditions.skill;
    },
    (s) => {
      s.models[0]!.profile.displayName = '/fictional/private/name';
    },
  ];
  for (const mutate of mutations) {
    const source = fixture();
    mutate(source);
    assert.throws(() => publicTaskResult(source, digest(30)));
  }
});
