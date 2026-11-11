import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import ts from 'typescript';
import { type Component, createSSRApp, h } from 'vue';
import { compileScript, parse } from 'vue/compiler-sfc';
import { renderToString } from 'vue/server-renderer';
import type { PublicBankCalibration } from './evals-calibration-types';
import type {
  PublicCampaign,
  PublishedAverage,
  PublishedMeasurements,
} from './evals-campaign-types';
import campaignIndex from './evals-campaigns.json';
import {
  bindCurrentSummary,
  bindPublishedCohort,
  type CampaignEntry,
  completePublishedCohorts,
  latestCampaignEntries,
  publishedModelRows,
} from './evals-cohorts';
import {
  combinedCampaignEntries,
  combinedModelRows,
  type UsageRemeasurement,
  withUsageRemeasurements,
} from './evals-combined';
import summaryJson from './evals-current-results.json';
import bankJson from './evals-latest-bank.json';
import type { PublicCurrentSummary } from './evals-summary-types';
import type { PublicTaskResult } from './evals-task-result-types';
import taskJson from './evals-task-result.json';
import remeasurementJson from './evals-usage-remeasurements.json';

function fixture(campaign: string, profile: string, passed: number) {
  const data: PublicCampaign = {
    campaignId: campaign,
    reportIdentity: `${campaign}-report`,
    bankId: 'current-bank',
    bankRevision: 'v2.1',
    stage: 'development',
    comparability: 'native-profile',
    models: [
      {
        status: 'recorded',
        planned: 6,
        profile: {
          id: profile,
          model: profile,
          displayName: profile,
          reasoningEffort: 'high',
          serviceTier: 'default',
        },
        report: {
          executions: 6,
          planned: 6,
          complete: true,
          macro: { base: 1, skill: passed / 3 },
          liftPercentagePoints: (100 * (passed - 3)) / 3,
          domains: [],
          tasks: [],
        },
      },
    ],
  };
  const entry: CampaignEntry = {
    file: `./evals-campaigns/${campaign}.json`,
    campaignId: campaign,
    reportIdentity: data.reportIdentity,
    bankId: data.bankId,
    bankRevision: data.bankRevision,
    stage: data.stage,
  };
  return { data, entry };
}

it('binds the current summary to one model row, updates task details and withholds cross-source pairing', () => {
  const summary = summaryJson as PublicCurrentSummary;
  const latest = taskJson as PublicTaskResult;
  const source = JSON.parse(
    readFileSync(new URL(summary.sources.base.file, import.meta.url), 'utf8'),
  ) as PublicCampaign;
  const entry: CampaignEntry = {
    ...summary.sources.base,
    bankRevision: summary.bankRevision,
    stage: summary.stage,
  };
  const rows = publishedModelRows([bindPublishedCohort(entry, source)]);
  const previous = structuredClone(source);
  const current = bindCurrentSummary(rows, summary, latest);
  assert.equal(current.length, 1);
  assert.equal(current[0]!.report!.counts!.skill!.passed, 24);
  assert.equal(current[0]!.report!.counts!.skill!.executions, 24);
  const task = current[0]!.report!.tasks.find((task) => task.id === 'P03')!;
  assert.equal(task.conditions.skill!.passed, 3);
  assert.ok(
    task.conditions.skill!.repetitions.every((run) => run.status === 'passed'),
  );
  assert.equal(task.comparison.valid, 0);
  assert.equal(task.comparison.liftPercentagePoints, null);
  assert.deepEqual(
    task.measurements,
    summary.tasks?.find((t) => t.id === 'P03')?.measurements,
  );
  assert.deepEqual(source, previous);
  for (const field of ['bankId', 'reportIdentity', 'campaignId'] as const) {
    const foreign = structuredClone(summary);
    foreign.sources.base[field] = 'foreign';
    assert.throws(() => bindCurrentSummary(rows, foreign, latest), /identity/);
  }
  assert.throws(
    () => bindCurrentSummary(rows, summary, { ...latest, identity: 'foreign' }),
    /identity/,
  );
});

it('shows only the current bank and latest report of each campaign/stage', () => {
  const { entry } = fixture('campaign-a', 'model-a', 2);
  const later = { ...entry, file: 'later.json', reportIdentity: 'later' };
  const sealed = { ...entry, stage: 'sealed', file: 'sealed.json' };
  const other = fixture('campaign-b', 'model-b', 3).entry;
  const oldBank = { ...other, bankId: 'other-bank' };
  const oldRevision = { ...other, bankRevision: 'v1' };
  assert.deepEqual(
    latestCampaignEntries([entry, oldBank, oldRevision, sealed, other, later], {
      bankId: entry.bankId!,
      bankRevision: entry.bankRevision,
    }),
    [later, sealed, other],
  );
});

it('keeps an explicitly bound current summary beside the current-bank model without admitting unrelated history', () => {
  const summary = summaryJson as PublicCurrentSummary;
  const base = summary.sources.base;
  const source: CampaignEntry = {
    ...base,
    bankRevision: summary.bankRevision,
    stage: summary.stage,
  };
  const sol = fixture('sol-current', 'gpt-6.1-sol', 2).entry;
  sol.stage = summary.stage;
  const unrelated = {
    ...source,
    campaignId: 'other-history',
    file: 'other.json',
  };
  const bank = { bankId: sol.bankId!, bankRevision: sol.bankRevision };
  assert.deepEqual(
    latestCampaignEntries([source, unrelated, sol], bank, summary),
    [sol, source],
  );
  assert.throws(
    () => latestCampaignEntries([unrelated, sol], bank, summary),
    /summary source/,
  );
  assert.throws(
    () =>
      latestCampaignEntries(
        [
          source,
          sol,
          { ...source, reportIdentity: 'later-report', file: 'later.json' },
        ],
        bank,
        summary,
      ),
    /summary source/,
  );
});

it('rejects each mismatched publication identity before displaying its scores', () => {
  const { entry, data } = fixture('campaign-a', 'model-a', 2);
  for (const field of [
    'bankId',
    'bankRevision',
    'campaignId',
    'reportIdentity',
    'stage',
  ] as const) {
    const changed = { ...data, [field]: 'foreign' };
    assert.throws(() => bindPublishedCohort(entry, changed), /identity/);
  }
  assert.throws(
    () =>
      bindPublishedCohort(entry, {
        ...data,
        models: [data.models[0]!, data.models[0]!],
      }),
    /identity/,
  );
});

it('keeps complete failed results and their downloads attached to their own sources', () => {
  const a = fixture('campaign-a', 'model-a', 2);
  const b = fixture('campaign-b', 'model-b', 3);
  const rows = publishedModelRows([
    bindPublishedCohort(a.entry, a.data),
    bindPublishedCohort(b.entry, b.data),
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.report, a.data.models[0]!.report);
  assert.equal(rows[0]!.report!.complete, true);
  assert.equal(rows[1]!.report, b.data.models[0]!.report);
  assert.equal(rows[0]!.source.reportIdentity, a.data.reportIdentity);
  assert.equal(rows[1]!.file, b.entry.file);
  assert.notEqual(rows[0]!.key, rows[1]!.key);
});

it('does not pool or select the best result when a profile has multiple campaigns', () => {
  const a = fixture('campaign-a', 'shared-profile', 1);
  const b = fixture('campaign-b', 'shared-profile', 3);
  const rows = publishedModelRows([
    bindPublishedCohort(a.entry, a.data),
    bindPublishedCohort(b.entry, b.data),
  ]);
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0]!.key, rows[1]!.key);
  assert.equal(rows[0]!.report, a.data.models[0]!.report);
  assert.equal(rows[1]!.report, b.data.models[0]!.report);
  assert.equal(rows[1]!.planned, 6);
});

it('shows only complete formal results while keeping failed trials and unknown money', () => {
  const complete = fixture('complete', 'model-a', 1);
  const partial = fixture('partial', 'model-b', 3);
  partial.data.models[0]!.report!.complete = false;
  const absent = fixture('absent', 'model-c', 3);
  absent.data.models[0]!.status = 'not_admitted';
  absent.data.models[0]!.report = null;
  const smoke = fixture('smoke', 'model-d', 3);
  smoke.entry.stage = 'smoke';
  smoke.data.stage = 'smoke';
  const pilot = fixture('pilot', 'model-e', 3);
  pilot.entry.stage = 'pilot';
  pilot.data.stage = 'pilot';
  const cohorts = [complete, partial, absent, smoke, pilot].map(
    ({ entry, data }) => bindPublishedCohort(entry, data),
  );
  assert.deepEqual(completePublishedCohorts(cohorts), [cohorts[0]]);
  const rows = publishedModelRows(cohorts);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.report!.macro.skill, 1 / 3);
  assert.equal(rows[0]!.report!.measurements, undefined);
});

it('does not fall back to an earlier complete report or expose an incomplete model in a mixed roster', () => {
  const earlier = fixture('campaign-a', 'model-a', 1);
  const later = fixture('campaign-a', 'model-a', 3);
  later.entry.reportIdentity = 'later-report';
  later.data.reportIdentity = 'later-report';
  later.data.models[0]!.report!.complete = false;
  const selected = latestCampaignEntries([earlier.entry, later.entry], {
    bankId: earlier.data.bankId,
    bankRevision: earlier.data.bankRevision,
  });
  assert.deepEqual(selected, [later.entry]);
  assert.deepEqual(
    publishedModelRows([bindPublishedCohort(selected[0]!, later.data)]),
    [],
  );
  const mixed = fixture('mixed', 'complete-model', 1);
  mixed.data.models.push(later.data.models[0]!);
  assert.deepEqual(
    publishedModelRows([bindPublishedCohort(mixed.entry, mixed.data)]).map(
      (row) => row.profile.id,
    ),
    ['complete-model'],
  );
});

const combinedBank = {
  bankId: 'current-bank',
  bankRevision: 'v2.1',
  tasks: [
    { id: 'C01', split: 'dev', domain: 'configuration', role: 'main' },
    { id: 'C02', split: 'dev', domain: 'configuration', role: 'main' },
    { id: 'W01', split: 'dev', domain: 'workflow', role: 'main' },
    { id: 'C03', split: 'sealed', domain: 'configuration', role: 'main' },
    {
      id: 'N01',
      split: 'dev',
      domain: 'negative-control',
      role: 'negative-control',
    },
    {
      id: 'N02',
      split: 'sealed',
      domain: 'negative-control',
      role: 'negative-control',
    },
  ] as const,
};

function cellMeasurements(mean: number): PublishedMeasurements {
  const metric: PublishedAverage = {
    mean,
    observedSum: mean * 3,
    total: mean * 3,
    measured: 3,
    executions: 3,
    coverage: 1,
    cells: 1,
    measuredCells: 1,
  };
  return {
    inputTokens: { ...metric },
    agentMs: { ...metric },
    endToEndMs: { ...metric },
    apiEquivalentUsd: { ...metric },
    settledUsd: {
      ...metric,
      mean: null,
      observedSum: 0,
      total: null,
      measured: 0,
      coverage: 0,
      measuredCells: 0,
    },
  };
}

function combinedFixtures(campaign = 'combined', profile = 'model-a') {
  return (['development', 'sealed'] as const).map((stage) => {
    const f = fixture(campaign, profile, 3);
    f.data.stage = stage;
    f.entry.stage = stage;
    f.data.reportIdentity = `${campaign}-${stage}`;
    f.entry.reportIdentity = f.data.reportIdentity;
    f.entry.file = `${campaign}-${stage}.json`;
    f.data.models[0]!.report!.tasks = combinedBank.tasks
      .filter(
        (task) => task.split === (stage === 'development' ? 'dev' : 'sealed'),
      )
      .map((spec) => ({
        ...spec,
        comparison: {
          planned: 3,
          valid: 3,
          regressed: 0,
          liftPercentagePoints: 0,
          pairs: [],
        },
        conditions: Object.fromEntries(
          ['base', 'skill'].map((condition) => {
            const isPassed =
              spec.role === 'negative-control' ||
              (spec.id === 'C01' || spec.id === 'C02') ===
                (condition === 'base');
            const status = isPassed ? 'passed' : 'assertion_failed';
            return [
              condition,
              {
                passed: isPassed ? 3 : 0,
                valid: 3,
                planned: 3,
                executions: 3,
                coverage: 1,
                bounds: isPassed ? [1, 1] : [0, 0],
                measurements: cellMeasurements(
                  spec.role === 'negative-control'
                    ? 10_000
                    : stage === 'development'
                      ? 10
                      : 100,
                ),
                repetitions: [1, 2, 3].map((repetition) => ({
                  repetition,
                  status,
                  attemptCount: 1,
                  attempts: [
                    {
                      id: `${spec.id}-${condition}-${repetition}`,
                      ordinal: 1,
                      status,
                    },
                  ],
                  activation: null,
                  attribution: null,
                })),
              },
            ];
          }),
        ),
      }));
    return f;
  });
}
const loadCombined = (fixtures: ReturnType<typeof combinedFixtures>) =>
  fixtures.map(({ entry, data }) => bindPublishedCohort(entry, data));

it('keeps task/domain macros separate from execution rates and excludes controls from both', () => {
  const fixtures = combinedFixtures();
  const before = structuredClone(fixtures);
  const [row] = combinedModelRows(loadCombined(fixtures), combinedBank);
  assert.ok(row);
  assert.equal(row.main.tasks.length, 4);
  assert.equal(row.negativeControls.tasks.length, 2);
  assert.deepEqual(row.main.counts.base, {
    passed: 6,
    valid: 12,
    planned: 12,
    executions: 12,
  });
  assert.ok(Math.abs(row.main.macro.base! - 1 / 3) < 1e-12);
  assert.ok(Math.abs(row.main.macro.skill! - 2 / 3) < 1e-12);
  assert.equal(row.main.attempts.base!.rate, 1 / 2);
  assert.equal(row.main.attempts.skill!.rate, 1 / 2);
  assert.equal(row.main.differencePercentagePoints, 0);
  assert.ok(
    Math.abs(row.main.macroDifferencePercentagePoints! - 100 / 3) < 1e-10,
  );
  assert.equal(row.main.measurements.agentMs.mean, 32.5);
  assert.equal(row.main.measurements.apiEquivalentUsd.executions, 24);
  assert.equal(row.negativeControls.measurements.agentMs.mean, 10_000);
  assert.equal(row.negativeControls.counts.base!.passed, 6);
  assert.equal(row.negativeControls.attempts.base!.rate, 1);
  assert.equal(row.negativeControls.attempts.base!.executions, 6);
  assert.deepEqual(
    row.sources.map((source) => source.source.stage),
    ['development', 'sealed'],
  );
  assert.equal(
    row.main.tasks.find((task) => task.id === 'C03')!.stage,
    'sealed',
  );
  assert.deepEqual(fixtures, before);
});

it('retains unknown and replacement executions, partial money and evidence-backed zero', () => {
  const fixtures = combinedFixtures();
  const task = fixtures[0]!.data.models[0]!.report!.tasks[0]!;
  const base = task.conditions.base!;
  base.executions = 4;
  base.repetitions[0]!.attemptCount = 2;
  base.repetitions[0]!.attempts.unshift({
    id: 'infra-original',
    ordinal: 0,
    status: 'unknown',
  });
  for (const metric of Object.values(base.measurements!)) {
    metric.executions = 4;
    metric.coverage = metric.measured / 4;
    metric.total = null;
  }
  const skill = task.conditions.skill!;
  skill.valid = 2;
  skill.repetitions[2]!.status = 'grader_error';
  skill.repetitions[2]!.attempts[0]!.status = 'grader_error';
  const zero =
    fixtures[1]!.data.models[0]!.report!.tasks[0]!.conditions.base!
      .measurements!.apiEquivalentUsd;
  zero.mean = 0;
  zero.observedSum = 0;
  zero.total = 0;
  const [row] = combinedModelRows(loadCombined(fixtures), combinedBank);
  assert.equal(row!.main.counts.base!.executions, 13);
  assert.equal(row!.main.counts.skill!.valid, 11);
  assert.equal(row!.main.attempts.base!.rate, 6 / 13);
  assert.equal(row!.main.attempts.base!.unknown, 1);
  assert.equal(row!.main.attempts.base!.coverage, 12 / 13);
  assert.equal(row!.main.attempts.skill!.unknown, 1);
  assert.equal(row!.main.attempts.skill!.coverage, 11 / 12);
  assert.equal(row!.main.measurements.agentMs.executions, 25);
  assert.equal(row!.main.measurements.agentMs.measured, 24);
  assert.equal(row!.main.measurements.agentMs.coverage, 24 / 25);
  assert.equal(row!.main.measurements.apiEquivalentUsd.total, null);
  assert.equal(row!.main.measurements.settledUsd.mean, null);
  assert.equal(row!.main.measurements.settledUsd.total, null);
  assert.equal(
    row!.main.tasks[0]!.conditions.base!.repetitions[0]!.attempts[0]!.status,
    'unknown',
  );
  assert.equal(
    row!.main.tasks.find((task) => task.id === 'C03')!.conditions.base!
      .measurements!.apiEquivalentUsd.mean,
    0,
  );
  const missing = structuredClone(fixtures);
  for (const f of missing) {
    const tasks = f.data.models[0]!.report!.tasks;
    for (const task of tasks)
      for (const condition of ['base', 'skill'])
        delete task.conditions[condition]!.measurements;
  }
  const [unknown] = combinedModelRows(loadCombined(missing), combinedBank);
  assert.equal(unknown!.main.measurements.apiEquivalentUsd.mean, null);
  assert.equal(unknown!.main.measurements.apiEquivalentUsd.executions, 25);
  assert.equal(unknown!.main.measurements.apiEquivalentUsd.coverage, 0);
});

it('withholds an incomplete bank and rejects mixed stage, model, task and measurement identities', () => {
  const fixtures = combinedFixtures();
  const oneStage = loadCombined(fixtures.slice(0, 1));
  assert.deepEqual(combinedModelRows(oneStage, combinedBank), []);
  const partial = structuredClone(fixtures);
  partial[1]!.data.models[0]!.report!.complete = false;
  partial[1]!.data.models[0]!.report!.tasks[0]!.conditions.base!.repetitions[2]!.attemptCount = 0;
  assert.deepEqual(combinedModelRows(loadCombined(partial), combinedBank), []);
  assert.throws(
    () =>
      combinedModelRows(
        loadCombined([...fixtures, fixtures[1]!]),
        combinedBank,
      ),
    /source identity/,
  );
  const mutations: ((f: ReturnType<typeof combinedFixtures>) => void)[] = [
    (f) => {
      f[1]!.data.bankId = 'foreign';
      f[1]!.entry.bankId = 'foreign';
    },
    (f) => {
      f[1]!.data.models[0]!.profile.model = 'foreign';
    },
    (f) => {
      f[1]!.data.models[0]!.profile.reasoningEffort = 'low';
    },
    (f) => {
      f[1]!.data.models[0]!.profile.serviceTier = 'priority';
    },
    (f) => {
      f[1]!.data.models[0]!.profile.codexVersion = 'other-cli';
    },
    (f) => {
      f[1]!.data.models[0]!.report!.tasks[0]!.id = 'C01';
    },
    (f) => {
      f[1]!.data.models[0]!.report!.tasks[0]!.role = 'negative-control';
    },
    (f) => {
      f[1]!.data.models[0]!.report!.tasks[0]!.domain = 'other';
    },
    (f) => {
      f[0]!.data.models[0]!.report!.tasks[1] =
        f[0]!.data.models[0]!.report!.tasks[0]!;
    },
    (f) => {
      f[0]!.data.models[0]!.report!.tasks[0]!.conditions.base!.measurements!.agentMs.executions = 99;
    },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(fixtures);
    mutate(changed);
    assert.throws(
      () => combinedModelRows(loadCombined(changed), combinedBank),
      /differs/,
    );
  }
  const other = combinedFixtures('other-campaign', 'other-profile');
  for (const f of other) f.data.models[0]!.profile.displayName = 'model-a';
  assert.equal(
    combinedModelRows(loadCombined([...fixtures, ...other]), combinedBank)
      .length,
    2,
  );
  other[1]!.data.models[0]!.profile.id = 'different-profile';
  assert.equal(
    combinedModelRows(loadCombined([...fixtures, ...other]), combinedBank)
      .length,
    1,
  );
});

it('combines both published model inventories with the selected P03 source and separate negative controls', () => {
  const summary = summaryJson as PublicCurrentSummary;
  const task = taskJson as PublicTaskResult;
  const bank = bankJson as PublicBankCalibration;
  const entries = combinedCampaignEntries(
    campaignIndex.campaigns,
    bankJson,
    summary,
  );
  assert.equal(entries.length, 4);
  const cohorts = entries.map((entry) => {
    const file = new URL(entry.file, import.meta.url);
    const data = JSON.parse(readFileSync(file, 'utf8')) as PublicCampaign;
    return bindPublishedCohort(entry, data);
  });
  const before = structuredClone(cohorts);
  const rows = combinedModelRows(cohorts, bank, { summary, task });
  assert.equal(rows.length, 2);
  const sol = rows.find((row) => row.profile.model === 'gpt-6.1-sol')!;
  const terra = rows.find((row) => row.profile.model === 'gpt-6.1-terra')!;
  assert.deepEqual(sol.main.counts.base, {
    passed: 69,
    valid: 72,
    planned: 72,
    executions: 72,
  });
  assert.deepEqual(sol.main.counts.skill, {
    passed: 70,
    valid: 72,
    planned: 72,
    executions: 72,
  });
  assert.equal(sol.main.measurements.apiEquivalentUsd.measured, 141);
  assert.equal(sol.main.measurements.apiEquivalentUsd.executions, 144);
  assert.deepEqual(terra.main.counts.base, {
    passed: 65,
    valid: 72,
    planned: 72,
    executions: 72,
  });
  assert.deepEqual(terra.main.counts.skill, {
    passed: 70,
    valid: 72,
    planned: 72,
    executions: 72,
  });
  assert.equal(terra.main.attempts.skill!.rate, 70 / 72);
  assert.equal(terra.main.attempts.skill!.unknown, 0);
  assert.equal(terra.main.attempts.skill!.coverage, 1);
  assert.ok(
    Math.abs(terra.main.differencePercentagePoints! - (100 * 5) / 72) < 1e-10,
  );
  assert.equal(terra.main.macro.skill, 70 / 72);
  assert.ok(
    Math.abs(terra.main.macroDifferencePercentagePoints! - (100 * 5) / 72) <
      1e-10,
  );
  for (const row of rows)
    for (const condition of ['base', 'skill']) {
      const counts = row.main.attempts[condition]!;
      assert.equal(counts.rate, counts.passed / counts.executions);
      assert.equal(counts.unknown + counts.valid, counts.executions);
    }
  for (const row of rows) {
    assert.equal(row.main.tasks.length, 24);
    assert.deepEqual(
      row.negativeControls.tasks.map((task) => task.id),
      ['N01', 'N02'],
    );
    assert.equal(row.negativeControls.counts.base!.passed, 6);
    assert.equal(row.negativeControls.counts.skill!.passed, 6);
  }
  const p03 = terra.main.tasks.find((task) => task.id === 'P03')!;
  assert.equal(p03.conditions.skill!.passed, 3);
  assert.equal(p03.comparison.valid, 0);
  assert.equal(p03.selectedCondition!.bankId, summary.sources.task.bankId);
  assert.equal(p03.source.bankId, summary.sources.base.bankId);
  const historicalEntry = campaignIndex.campaigns.find(
    (entry) =>
      entry.reportIdentity ===
      '9f59982d9ab4fe1d0de36817a21f3e89d5a1e229adc7ef8035e089fb93a2a761',
  );
  assert.ok(historicalEntry);
  const historical = JSON.parse(
    readFileSync(new URL(historicalEntry.file, import.meta.url), 'utf8'),
  ) as PublicCampaign;
  const original = historical.models[0]!.report!.tasks.find(
    (task) => task.id === 'K01',
  )!.conditions.skill!;
  const reviewed = terra.main.tasks.find((task) => task.id === 'K01')!
    .conditions.skill!;
  assert.equal(historical.models[0]!.report!.complete, false);
  assert.equal(original.repetitions[2]!.status, 'grader_error');
  assert.equal(reviewed.repetitions[2]!.status, 'passed');
  assert.equal(
    reviewed.repetitions[2]!.attempts[0]!.id,
    original.repetitions[2]!.attempts[0]!.id,
  );
  assert.equal(reviewed.executions, original.executions);
  assert.deepEqual(reviewed.measurements, original.measurements);
  assert.equal(
    terra.main.tasks.find((task) => task.id === 'I03')!.conditions.skill!
      .passed,
    1,
  );
  assert.deepEqual(cohorts, before);
  const foreign = campaignIndex.campaigns.map((entry) =>
    entry.campaignId === summary.sources.base.campaignId &&
    entry.stage === 'development'
      ? { ...entry, bankId: 'foreign' }
      : entry,
  );
  assert.throws(
    () => combinedCampaignEntries(foreign, bankJson, summary),
    /companion Bank identity/,
  );
});

it('selects both models I03 and Terra P03 in their own model and stage without crossing execution identities or changing history', () => {
  const initializationSummary = JSON.parse(
    readFileSync(
      new URL('evals-current-i03-results.json', import.meta.url),
      'utf8',
    ),
  ) as PublicCurrentSummary;
  const initializationResult = JSON.parse(
    readFileSync(
      new URL('evals-i03-task-result.json', import.meta.url),
      'utf8',
    ),
  ) as PublicTaskResult;
  const solSummary = JSON.parse(
    readFileSync(
      new URL('evals-current-i03-gpt-6.1-sol-results.json', import.meta.url),
      'utf8',
    ),
  ) as PublicCurrentSummary;
  const solResult = JSON.parse(
    readFileSync(
      new URL('evals-i03-gpt-6.1-sol-task-result.json', import.meta.url),
      'utf8',
    ),
  ) as PublicTaskResult;
  const selections = [
    {
      summary: summaryJson as PublicCurrentSummary,
      task: taskJson as PublicTaskResult,
    },
    { summary: initializationSummary, task: initializationResult },
    { summary: solSummary, task: solResult },
  ];
  const entries = combinedCampaignEntries(
    campaignIndex.campaigns,
    bankJson,
    selections.map((item) => item.summary),
  );
  const cohorts = entries.map((entry) => {
    const bytes = readFileSync(new URL(entry.file, import.meta.url), 'utf8');
    return bindPublishedCohort(entry, JSON.parse(bytes) as PublicCampaign);
  });
  const before = structuredClone(cohorts);
  const rows = combinedModelRows(
    cohorts,
    bankJson as PublicBankCalibration,
    selections,
  );
  assert.equal(rows.length, 2);
  const terra = rows.find((row) => row.profile.model === 'gpt-6.1-terra')!;
  const sol = rows.find((row) => row.profile.model === 'gpt-6.1-sol')!;
  assert.deepEqual(terra.main.counts.skill, {
    passed: 72,
    valid: 72,
    planned: 72,
    executions: 72,
  });
  assert.equal(terra.main.counts.base!.passed, 65);
  assert.equal(terra.main.attempts.skill!.rate, 1);
  assert.equal(terra.main.attempts.skill!.unknown, 0);
  assert.equal(terra.main.attempts.skill!.coverage, 1);
  assert.ok(
    Math.abs(terra.main.differencePercentagePoints! - (100 * 7) / 72) < 1e-10,
  );
  assert.equal(terra.main.macro.skill, 1);
  assert.equal(sol.main.counts.skill!.passed, 72);
  assert.equal(sol.main.counts.skill!.executions, 72);
  assert.equal(sol.main.counts.base!.passed, 69);
  assert.equal(sol.main.attempts.skill!.unknown, 0);
  assert.equal(sol.main.attempts.skill!.coverage, 1);
  assert.ok(
    Math.abs(sol.main.differencePercentagePoints! - (100 * 3) / 72) < 1e-10,
  );
  assert.equal(terra.main.tasks.length, 24);
  assert.equal(terra.negativeControls.counts.skill!.passed, 6);
  assert.equal(terra.negativeControls.counts.skill!.executions, 6);
  assert.equal(sol.negativeControls.counts.skill!.passed, 6);
  assert.equal(sol.negativeControls.counts.skill!.executions, 6);
  const initializationTask = terra.main.tasks.find(
    (task) => task.id === 'I03',
  )!;
  const p03 = terra.main.tasks.find((task) => task.id === 'P03')!;
  assert.equal(initializationTask.stage, 'development');
  assert.equal(
    initializationTask.selectedCondition!.bankId,
    initializationResult.bankId,
  );
  assert.equal(
    initializationTask.selectedCondition!.experimentIdentity,
    initializationResult.experimentIdentity,
  );
  assert.equal(
    initializationTask.selectedCondition!.executionIdentity,
    initializationResult.executionIdentity,
  );
  assert.deepEqual(
    initializationTask.conditions.skill!.measurements,
    initializationResult.measurements,
  );
  assert.deepEqual(
    initializationTask.conditions.skill!.repetitions.map((run) => run.status),
    ['passed', 'passed', 'passed'],
  );
  assert.equal(initializationTask.comparison.valid, 0);
  assert.equal(initializationTask.comparison.liftPercentagePoints, null);
  const solTask = sol.main.tasks.find((task) => task.id === 'I03')!;
  assert.equal(solTask.conditions.skill!.passed, 3);
  assert.equal(solTask.selectedCondition!.bankId, solResult.bankId);
  assert.equal(
    solTask.selectedCondition!.experimentIdentity,
    solResult.experimentIdentity,
  );
  assert.equal(solTask.comparison.valid, 0);
  assert.equal(solTask.comparison.liftPercentagePoints, null);
  assert.equal(p03.conditions.skill!.passed, 3);
  assert.equal(
    p03.selectedCondition!.bankId,
    (taskJson as PublicTaskResult).bankId,
  );
  const original = cohorts
    .flatMap(({ data }) => data.models)
    .flatMap((model) => model.report?.tasks ?? [])
    .find((task) => task.id === 'I03' && task.conditions.skill!.passed === 1);
  assert.ok(original);
  assert.deepEqual(cohorts, before);
  for (const change of [
    (s: typeof selections) => {
      s[1]!.task.experimentIdentity = 'foreign';
    },
    (s: typeof selections) => {
      s[1]!.summary.revision!.from.gradingIdentity = 'foreign';
    },
    (s: typeof selections) => {
      s[1]!.task.gradingIdentity = 'foreign';
    },
    (s: typeof selections) => {
      s[2]!.task.profile.id = initializationResult.profile.id;
    },
  ]) {
    const wrong = structuredClone(selections);
    change(wrong);
    assert.throws(
      () =>
        combinedModelRows(cohorts, bankJson as PublicBankCalibration, wrong),
      /source identity/,
    );
  }
  assert.throws(
    () =>
      combinedModelRows(cohorts, bankJson as PublicBankCalibration, [
        ...selections,
        selections[1]!,
      ]),
    /source identity/,
  );
  assert.throws(
    () =>
      combinedCampaignEntries(campaignIndex.campaigns, bankJson, [
        initializationSummary,
        initializationSummary,
      ]),
    /Duplicate current stage/,
  );
});

function readPublishedFixture<T>(file: string): T {
  return JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8')) as T;
}

function usageMeasurementRows() {
  const selections = [
    {
      summary: summaryJson as PublicCurrentSummary,
      task: taskJson as PublicTaskResult,
    },
    {
      summary: readPublishedFixture<PublicCurrentSummary>(
        'evals-current-i03-results.json',
      ),
      task: readPublishedFixture<PublicTaskResult>(
        'evals-i03-task-result.json',
      ),
    },
    {
      summary: readPublishedFixture<PublicCurrentSummary>(
        'evals-current-i03-gpt-6.1-sol-results.json',
      ),
      task: readPublishedFixture<PublicTaskResult>(
        'evals-i03-gpt-6.1-sol-task-result.json',
      ),
    },
  ];
  const entries = combinedCampaignEntries(
    campaignIndex.campaigns,
    bankJson,
    selections.map((item) => item.summary),
  );
  return combinedModelRows(
    entries.map((entry) =>
      bindPublishedCohort(
        entry,
        readPublishedFixture<PublicCampaign>(entry.file),
      ),
    ),
    bankJson as PublicBankCalibration,
    selections,
  );
}

it('recomputes complete input and API cost means from selected usage without changing scores, timing or historical sources', () => {
  const receipts = remeasurementJson.remeasurements as UsageRemeasurement[];
  const rows = usageMeasurementRows();
  const before = structuredClone(rows);
  const selected = withUsageRemeasurements(rows, receipts);
  // These means come from the independently audited six raw measurements.
  const expected: Record<string, [number, number]> = {
    C03: [463_256, 0.1675442666666667],
    S01: [201_751, 0.08386633333333335],
    S02: [127_773, 0.059617],
    R01: [279_653.1666666667, 0.05272963333333333],
  };
  assert.equal(receipts.length, 4);
  for (const previous of rows) {
    const current = selected.find((row) => row.key === previous.key)!;
    assert.deepEqual(current.sources, previous.sources);
    assert.deepEqual(current.main.counts, previous.main.counts);
    assert.deepEqual(current.main.attempts, previous.main.attempts);
    assert.deepEqual(current.main.macro, previous.main.macro);
    assert.equal(
      current.main.differencePercentagePoints,
      previous.main.differencePercentagePoints,
    );
    assert.deepEqual(current.negativeControls, previous.negativeControls);
    for (const key of ['inputTokens', 'apiEquivalentUsd', 'agentMs'] as const) {
      assert.equal(current.main.measurements[key]!.measured, 144);
      assert.equal(current.main.measurements[key]!.executions, 144);
      assert.equal(current.main.measurements[key]!.coverage, 1);
      assert.equal(current.negativeControls.measurements[key]!.measured, 12);
      assert.equal(current.negativeControls.measurements[key]!.coverage, 1);
    }
    for (const key of ['agentMs', 'endToEndMs', 'settledUsd'] as const)
      assert.deepEqual(
        current.main.measurements[key],
        previous.main.measurements[key],
      );
    for (const original of previous.main.tasks) {
      const task = current.main.tasks.find((task) => task.id === original.id)!;
      assert.deepEqual(task.comparison, original.comparison);
      for (const condition of ['base', 'skill'])
        assert.deepEqual(
          task.conditions[condition]!.repetitions,
          original.conditions[condition]!.repetitions,
        );
      for (const key of ['agentMs', 'endToEndMs', 'settledUsd'] as const)
        assert.deepEqual(task.measurements![key], original.measurements![key]);
      if (!task.measurementRemeasurement) {
        assert.strictEqual(task, original);
        continue;
      }
      assert.equal(task.measurementRemeasurement.selectedExecutions, 6);
      assert.equal(task.measurementRemeasurement.sourceExecutions, 7);
      assert.equal(original.measurements!.inputTokens!.measured, 5);
      assert.equal(original.measurements!.apiEquivalentUsd!.measured, 5);
      for (const key of ['inputTokens', 'apiEquivalentUsd'] as const) {
        assert.equal(task.measurements![key]!.measured, 6);
        assert.equal(task.measurements![key]!.coverage, 1);
        assert.notEqual(task.measurements![key]!.total, null);
      }
      const expectation = expected[task.id];
      assert.ok(expectation);
      assert.equal(task.measurements!.inputTokens!.mean, expectation[0]);
      assert.ok(
        Math.abs(task.measurements!.apiEquivalentUsd!.mean! - expectation[1]) <
          1e-12,
      );
    }
  }
  assert.deepEqual(rows, before);
});

it('withholds incomplete final usage and rejects wrong source, price, calculation and duplicate selections', () => {
  const receipts = remeasurementJson.remeasurements as UsageRemeasurement[];
  const rows = usageMeasurementRows();
  const mutations: ((value: UsageRemeasurement) => void)[] = [
    (value) => {
      value.source.reportIdentity = 'foreign';
    },
    (value) => {
      value.source.attemptId = 'foreign';
    },
    (value) => {
      value.source.stage =
        value.source.stage === 'sealed' ? 'development' : 'sealed';
    },
    (value) => {
      value.supplemental.modelProfileId = 'foreign';
    },
    (value) => {
      value.supplemental.repetition = 3;
    },
    (value) => {
      value.supplemental.fixtureIdentity = 'foreign';
    },
    (value) => {
      value.supplemental.executionIdentity = 'foreign';
    },
    (value) => {
      value.supplemental.gradingIdentity = 'foreign';
    },
    (value) => {
      value.supplemental.complete = false;
    },
    (value) => {
      value.supplemental.costComplete = false;
    },
    (value) => {
      value.supplemental.apiEquivalentUsd = NaN;
    },
    (value) => {
      value.supplemental.apiEquivalentUsd = -1;
    },
    (value) => {
      value.supplemental.pricingIdentity = '0'.repeat(64);
    },
    (value) => {
      value.selection.sourceExecutions = 6;
    },
    (value) => {
      value.source.conditionInputTokens.mean = 0;
    },
    (value) => {
      value.source.conditionApiEquivalentUsd.mean = 0;
    },
    (value) => {
      value.measurements.taskInputTokens.mean!++;
    },
    (value) => {
      value.measurements.taskApiEquivalentUsd.mean!++;
    },
    (value) => {
      value.measurements.conditionApiEquivalentUsd.measured = 2;
    },
  ];
  for (let index = 0; index < receipts.length; index++) {
    for (const mutate of mutations) {
      const invalid = structuredClone(receipts);
      mutate(invalid[index]!);
      assert.throws(
        () => withUsageRemeasurements(rows, invalid),
        /Usage remeasurement/,
      );
    }
    assert.throws(
      () =>
        withUsageRemeasurements(
          rows,
          receipts.filter((_, candidateIndex) => candidateIndex !== index),
        ),
      /Final usage measurement is incomplete/,
    );
  }
  assert.throws(
    () => withUsageRemeasurements(rows, [...receipts, receipts[0]!]),
    /source identity/,
  );
  const complete = withUsageRemeasurements(rows, receipts);
  assert.throws(
    () => withUsageRemeasurements(complete, receipts),
    /source identity/,
  );
  const partialTiming = structuredClone(complete);
  partialTiming[0]!.main.tasks[0]!.measurements!.agentMs!.measured--;
  assert.throws(
    () => withUsageRemeasurements(partialTiming, []),
    /Final usage measurement is incomplete/,
  );
});

it('retains fully unresolved attempts in the primary denominator while keeping macros unknown', () => {
  const fixtures = combinedFixtures();
  for (const { data } of fixtures) {
    const report = data.models[0]!.report!;
    report.complete = false;
    for (const task of report.tasks) {
      if (task.role !== 'main') continue;
      for (const cell of Object.values(task.conditions)) {
        cell.passed = 0;
        cell.valid = 0;
        cell.coverage = 0;
        cell.bounds = [0, 1];
        for (const run of cell.repetitions) {
          run.status = 'grader_error';
          run.attempts[0]!.status = 'grader_error';
        }
      }
    }
  }
  const [row] = combinedModelRows(loadCombined(fixtures), combinedBank);
  assert.ok(row);
  assert.equal(row.main.macro.base, null);
  assert.equal(row.main.macro.skill, null);
  assert.equal(row.main.macroDifferencePercentagePoints, null);
  assert.equal(row.main.differencePercentagePoints, 0);
  for (const condition of ['base', 'skill']) {
    assert.equal(row.main.attempts[condition]!.rate, 0);
    assert.equal(row.main.attempts[condition]!.unknown, 12);
    assert.equal(row.main.attempts[condition]!.coverage, 0);
  }
  assert.equal(row.negativeControls.attempts.base!.rate, 1);
});

async function rateComponent(): Promise<Component> {
  const file = new URL('EvalsRate.vue', import.meta.url);
  const { descriptor } = parse(readFileSync(file, 'utf8'));
  const script = compileScript(descriptor, {
    id: 'evals-rate-contract',
    inlineTemplate: true,
  });
  const { outputText } = ts.transpileModule(script.content, {
    compilerOptions: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
    },
  });
  const code = outputText.replaceAll(
    /from (['"])vue\1/g,
    () => `from ${JSON.stringify(import.meta.resolve('vue'))}`,
  );
  const url = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
  const loaded = await import(url);
  return loaded.default as Component;
}

it('renders the percentage from its displayed execution counts, including zero and unresolved attempts', async () => {
  const component = await rateComponent();
  for (const [passed, executions, expected] of [
    [69, 72, '95.8%'],
    [1, 4, '25.0%'],
    [0, 3, '0.0%'],
    [3, 3, '100.0%'],
    [0, 0, 'N/A'],
  ] as const) {
    const app = createSSRApp({
      render: () =>
        h(component, {
          passed,
          executions,
          condition: 'skill',
          // A legacy caller cannot override the percentage with an independent macro.
          value: 70 / 72,
        }),
    });
    const html = await renderToString(app);
    assert.ok(
      html.includes(`<span class="rate-value">${expected}</span>`),
      html,
    );
    assert.ok(html.includes(`<small>${passed}/${executions}</small>`), html);
    assert.equal(html.includes('class="rate-track"'), executions > 0);
  }
});
