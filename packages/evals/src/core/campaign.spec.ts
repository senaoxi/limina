import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runCampaignSchedule } from '../controller/campaign.ts';
import { bindRunBudget } from '../controller/run-budget.ts';
import { appendAttribution } from './attribution.ts';
import { BudgetManager, type UsageRecord } from './budget.ts';
import { buildCampaignReport } from './campaign-report.ts';
import { campaignFixture } from './campaign.test-helper.ts';
import {
  campaignExperiment,
  campaignSchedule,
  createCampaign,
} from './campaign.ts';
import {
  createExperiment,
  freezeTaskIdentity,
  verifyExperiment,
} from './experiment.ts';
import { contentIdentity } from './identity.ts';
import { createModelProfile } from './model-profile.ts';
import { type EvidenceReference, RunStore } from './run-store.ts';
import { sha256 } from './snapshot.ts';
import { createTaskBank, verifyTaskBank } from './task-bank.ts';

const usage: UsageRecord = {
  inputTokens: 7,
  cachedInputTokens: 3,
  outputTokens: 2,
  credits: null,
  estimatedUsd: null,
  settledUsd: null,
  source: 'synthetic offline measurement',
  complete: true,
  settlement: 'unknown',
};

test('legacy bank and manifest identities survive revision-aware readers unchanged', () => {
  // Captured from the archived pre-v2.1 source, independently of these readers.
  for (const [revision, bankId, manifestId] of [
    [
      'v1',
      '54eb3d156f94786a7a1ed8593b44e41672c292b297e199c06e845f060ea6d26d',
      'ac0e1298ab7d5bf794879a8611d4c10943bf11b9da3a4cfb723571ea8c1f24b2',
    ],
    [
      'v2',
      'ffaff5ee52a4aa98e5c8ff5e288a2c6d54aff65bf21f9cb47b3155e818f97e88',
      '5b2be95d05eb43e43ba989b6fee5d8d0c4debb0c96eb0d0d1d6869dc25c35df1',
    ],
  ] as const) {
    const { campaign } = campaignFixture(revision);
    const serializedBank = JSON.stringify(campaign.bank);
    const bank = JSON.parse(serializedBank);
    assert.equal(bank.id, bankId);
    verifyTaskBank(bank);
    const manifest = campaignExperiment(
      campaign,
      campaign.profiles[0]!.id,
      'development',
    );
    assert.equal(manifest.identity, manifestId);
    const serializedManifest = JSON.stringify(manifest);
    verifyExperiment(JSON.parse(serializedManifest));
  }
  const { campaign, tasks, fixed } = campaignFixture('v1');
  const legacy = createExperiment({
    ...campaign.common,
    kind: 'development',
    seed: campaign.seed,
    tasks: tasks
      .filter((task) => task.split === 'dev')
      .toSorted((a, b) => a.id.localeCompare(b.id))
      .map((task) => freezeTaskIdentity(task, fixed, fixed)),
    conditions: [
      { id: 'base', skillDigest: null },
      { id: 'skill', skillDigest: fixed },
    ],
  });
  assert.equal(legacy.version, 1);
  assert.equal(
    legacy.identity,
    '4619b2fcad8f4628acd884c490d2d381d6150032d564cad123d43641000a554e',
  );
  const serializedLegacy = JSON.stringify(legacy);
  verifyExperiment(JSON.parse(serializedLegacy));
});

test('bank revisions have separate scenarios and comparison cells and reject every mixed bank', () => {
  const revisions = ['v1', 'v2', 'v2.1', 'v2.2'] as const;
  const fixtures = revisions.map((revision) => campaignFixture(revision));
  assert.equal(
    new Set(fixtures.map((f) => f.campaign.bank.id)).size,
    revisions.length,
  );
  const slots = fixtures.map(
    ({ campaign }) =>
      campaignExperiment(
        campaign,
        campaign.profiles[0]!.id,
        'development',
      ).slots.find(
        (slot) =>
          slot.taskId === 'I01' &&
          slot.repetition === 1 &&
          slot.condition === 'base',
      )!,
  );
  assert.equal(
    new Set(slots.map((slot) => slot.comparisonIdentity)).size,
    revisions.length,
  );
  assert.equal(
    new Set(slots.map((slot) => slot.designCellId)).size,
    revisions.length,
  );
  for (const [index, fixture] of fixtures.entries()) {
    const revision = revisions[index]!;
    const serializedBank = JSON.stringify(fixture.campaign.bank);
    verifyTaskBank(JSON.parse(serializedBank));
    assert.ok(fixture.tasks.every((task) => task.version === 2));
    assert.equal(
      fixture.campaign.bank.tasks.find((task) => task.id === 'I01')!.scenarioId,
      `${revision}:I01`,
    );
    for (const other of fixtures) {
      if (other === fixture) continue;
      const foreign = other.tasks.find((task) => task.id === 'I01')!;
      assert.throws(
        () =>
          createTaskBank(
            revision,
            fixture.tasks.map((local) => {
              const task = local.id === foreign.id ? foreign : local;
              return {
                task,
                identity: freezeTaskIdentity(
                  task,
                  fixture.fixed,
                  fixture.fixed,
                ),
              };
            }),
          ),
        /another bank or split/,
      );
    }
  }
});

test('campaign balances model position and arm order while isolating model identities', () => {
  const { campaign: c, profiles } = campaignFixture();
  const schedule = campaignSchedule(c, 'development');
  assert.equal(schedule.length, 306);
  const active = c.profiles.slice(0, 2).map((p) => p.id);
  const subset = campaignSchedule(c, 'development', undefined, active);
  assert.equal(subset.length, 204);
  const firstCounts = active.map(
    (id) =>
      subset.filter(
        (slot, index) => index % 4 === 0 && slot.modelProfileId === id,
      ).length,
  );
  assert.ok(Math.abs(firstCounts[0]! - firstCounts[1]!) <= 1);
  assert.deepEqual(schedule, campaignSchedule(c, 'development'));
  const firstPositions = new Map(profiles.map((p) => [p.id, 0]));
  for (let index = 0; index < schedule.length; index += 6)
    firstPositions.set(
      schedule[index]!.modelProfileId,
      firstPositions.get(schedule[index]!.modelProfileId)! + 1,
    );
  assert.deepEqual(firstPositions.values().toArray(), [17, 17, 17]);
  const plans = profiles.map((p) => campaignExperiment(c, p.id, 'development'));
  for (const p of plans) {
    const starts = p.slots.filter((_, index) => index % 2 === 0);
    assert.ok(
      Math.abs(
        starts.filter((s) => s.condition === 'base').length -
          starts.filter((s) => s.condition === 'skill').length,
      ) <= 1,
    );
  }
  assert.equal(
    plans[0]!.slots[0]!.designCellId,
    plans[1]!.slots[0]!.designCellId,
  );
  assert.notEqual(
    plans[0]!.slots[0]!.comparisonIdentity,
    plans[1]!.slots[0]!.comparisonIdentity,
  );
  assert.notEqual(plans[0]!.slots[0]!.id, plans[1]!.slots[0]!.id);
  const { id: _id, version: _v, ...input } = profiles[0]!;
  assert.equal(
    createModelProfile({ ...input, displayName: 'Another label' }).id,
    profiles[0]!.id,
  );
  assert.notEqual(
    createModelProfile({
      ...input,
      execution: { ...input.execution, contextWindow: 260_000 },
    }).id,
    profiles[0]!.id,
  );
  const {
    id: _c,
    version: _cv,
    orderingVersion: _o,
    commonContractId: _common,
    ...ci
  } = c;
  assert.throws(
    () =>
      createCampaign({
        ...ci,
        profiles: [
          profiles[0]!,
          createModelProfile({
            ...input,
            canonicalModelId: 'other-model',
            instructionDigest: contentIdentity('other instructions'),
          }),
        ],
      }),
    /not strictly comparable/,
  );
});

test('actual stores and one ledger resume a campaign without replacing Agent failures', async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'eval-campaign-'));
  const root = await realpath(temporary);
  t.after(() => rm(root, { recursive: true, force: true }));
  const { campaign: c, tasks, fixed } = campaignFixture();
  const budgetFile = path.join(root, 'budget.jsonl');
  writeFileSync(budgetFile, '');
  const budget = new BudgetManager(budgetFile);
  const stores = new Map(
    c.profiles.map((p) => [
      p.id,
      new RunStore(
        path.join(root, p.id),
        campaignExperiment(c, p.id, 'development'),
      ),
    ]),
  );
  for (const s of stores.values()) await bindRunBudget(s, budgetFile);
  const dispatch = async (id: string, slotId: string) => {
    const store = stores.get(id)!;
    const profile = store.manifest.inputs.modelProfile!;
    const next = store.next()!;
    assert.equal(next.slot.id, slotId);
    const runId = `${slotId}-${next.ordinal}`;
    budget.reserveAttempt({
      runId,
      taskId: next.slot.taskId,
      model: profile.canonicalModelId,
      reasoningEffort: profile.reasoningEffort,
      serviceTier: 'default',
      modelProfile: profile,
      campaignId: c.id,
      experimentIdentity: store.manifest.identity,
      slotId,
      maximumUsd: 0,
      estimatedUsd: null,
      billing: {
        mode: 'included_only',
        observedAt: new Date().toISOString(),
        source: 'offline-account-control',
        autoReloadDisabled: true,
        ordinaryUsageAllowed: true,
        accountPlan: 'pro',
        unlimitedCredits: false,
        creditBalance: 0,
        rateCardVersion: null,
        providerEnforcedCeilingUsd: null,
      },
    });
    const started = store.startNext({ slotId, ordinal: next.ordinal })!;
    assert.equal(started.runId, runId);
    budget.recordUsage(runId, usage);
    const isFailed =
      next.slot.taskId === 'C01' && next.slot.condition === 'skill';
    const evidence: EvidenceReference[] = [];
    for (const kind of [
      'fixture',
      'start',
      'final',
      'trace',
      'assertions',
    ] as const) {
      const relative = `${runId}-${kind}.json`;
      const text = JSON.stringify(
        kind === 'trace'
          ? {
              evidence: {
                status: 'complete',
                modelProfileId: profile.id,
                observedModelIds: [profile.canonicalModelId],
              },
            }
          : { syntheticOfflineEvidence: true },
      );
      writeFileSync(path.join(store.directory, relative), text);
      evidence.push({ kind, path: relative, sha256: sha256(text) });
    }
    store.finish(runId, tasks.find((t) => t.id === next.slot.taskId)!, {
      facts: {
        execution: { status: 'completed', exitCode: 0 },
        captureStatus: 'complete',
        traceStatus: 'complete',
        mutation: {
          status: 'accepted',
          changes: [],
          dependencyVariant: {
            id: 'fixed',
            inputsDigest: contentIdentity([]),
            closureDigest: fixed,
          },
        },
        grade: {
          taskId: next.slot.taskId,
          graderDigest: contentIdentity({ grader: next.slot.taskId }),
          status: 'complete',
          assertions: [{ id: 'semantic', passed: !isFailed }],
        },
      },
      usage,
      time: { agentMs: 1, endToEndMs: 2 },
      activation: {
        installed: next.slot.condition === 'base' ? 'no' : 'yes',
        discovered: 'unknown',
        used: 'unknown',
      },
      evidence,
    });
  };
  let launched = 0;
  await assert.rejects(
    runCampaignSchedule(c, 'development', root, stores, async (id, slot) => {
      await dispatch(id, slot);
      if (++launched === 5) throw new Error('simulated controller stop');
    }),
    /simulated/,
  );
  const before = budget.summary().attempts.length;
  assert.equal(before, 5);
  await runCampaignSchedule(c, 'development', root, stores, dispatch);
  assert.equal(budget.summary().attempts.length, 306);
  const inputs = stores
    .values()
    .map((store) => ({
      manifest: store.manifest,
      summary: store.summary(),
      budget: budget.summary(),
      attributions: [],
    }))
    .toArray();
  const report = buildCampaignReport(c, 'development', inputs, fixed);
  assert.equal(report.models[0]!.report!.planned, 102);
  assert.equal(report.models[0]!.report!.executions, 102);
  const c01 = report.models[0]!.report!.tasks.find((t) => t.id === 'C01')!;
  assert.equal(c01.conditions.skill!.rate, 0);
  assert.equal(c01.comparison.regressed, 3);
  const old = contentIdentity(report);
  const store = stores.values().next().value!;
  const run = store.summary().attempts[0]!;
  appendAttribution(store, {
    runId: run.runId,
    rubricDigest: fixed,
    primary: 'unknown',
    contributing: [],
    evidence: [],
    confidence: 'unknown',
    adjudication: 'unreviewed',
  });
  assert.equal(
    contentIdentity(buildCampaignReport(c, 'development', inputs, fixed)),
    old,
  );
  assert.equal(RunStore.open(store.directory).summary().attempts.length, 102);
  assert.throws(() => RunStore.open(store.directory).startNext(), /Read-only/);
  const bytes = readFileSync(path.join(store.directory, 'attempts.jsonl'));
  assert.ok(bytes.length > 0);
  const foreign = structuredClone(inputs[0]!);
  foreign.budget = structuredClone(foreign.budget);
  foreign.budget.attempts.find(
    (a) => a.reservation.runId === run.runId,
  )!.reservation.modelProfile = c.profiles.find(
    (p) => p.id !== run.modelProfileId,
  )!;
  assert.throws(
    () => buildCampaignReport(c, 'development', [foreign], fixed),
    /shared budget/,
  );
});

test('missing model and unresolved slots retain the assigned denominator and no cross-model rank', async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'eval-missing-model-'));
  const root = await realpath(temporary);
  t.after(() => rm(root, { recursive: true, force: true }));
  const { campaign: c, fixed } = campaignFixture();
  const store = new RunStore(
    path.join(root, 'run'),
    campaignExperiment(c, c.profiles[0]!.id, 'development'),
  );
  const b = new BudgetManager(path.join(root, 'budget.jsonl')).summary();
  const report = buildCampaignReport(
    c,
    'development',
    [
      {
        manifest: store.manifest,
        summary: store.summary(),
        budget: b,
        attributions: [],
      },
    ],
    fixed,
  );
  const task = report.models[0]!.report!.tasks[0]!;
  assert.deepEqual(task.conditions.base!.bounds, [0, 1]);
  assert.equal(task.conditions.base!.planned, 3);
  assert.equal(task.conditions.base!.valid, 0);
  assert.equal(report.models[1]!.status, 'missing');
  assert.equal(report.contrasts[0]!.baseDifferencePercentagePoints, null);
  assert.equal(store.next()!.ordinal, 1);
  mkdirSync(path.join(root, '.dispatch-lock'));
  await assert.rejects(
    runCampaignSchedule(c, 'development', root, new Map(), async () => {}),
    /EEXIST/,
  );
});
