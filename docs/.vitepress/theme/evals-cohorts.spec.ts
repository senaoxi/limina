import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import type { PublicCampaign } from './evals-campaign-types';
import {
  bindCurrentSummary,
  bindPublishedCohort,
  type CampaignEntry,
  completePublishedCohorts,
  latestCampaignEntries,
  publishedModelRows,
} from './evals-cohorts';
import summaryJson from './evals-current-results.json';
import type { PublicCurrentSummary } from './evals-summary-types';
import type { PublicTaskResult } from './evals-task-result-types';
import taskJson from './evals-task-result.json';

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
