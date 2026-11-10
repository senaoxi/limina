import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type AttemptCost,
  buildCampaignMeasurements,
} from './campaign-measurements.ts';
import { campaignFixture } from './campaign.test-helper.ts';
import { campaignExperiment } from './campaign.ts';
import type { AttemptRecord } from './run-store.ts';

function fixture() {
  const { campaign } = campaignFixture('v2.1');
  const manifest = campaignExperiment(
    campaign,
    campaign.profiles[0]!.id,
    'development',
  );
  const attempts: AttemptRecord[] = [];
  const costs: AttemptCost[] = [];
  function add(
    taskId: string,
    condition: string,
    ms: number | null,
    usd: number | null,
    status: AttemptRecord['outcome']['status'] = 'passed',
  ) {
    const slot = manifest.slots.find(
      (s) => s.taskId === taskId && s.condition === condition,
    )!;
    const runId = `offline-${attempts.length}`;
    attempts.push({
      version: 2,
      modelProfileId: manifest.inputs.modelProfile!.id,
      runId,
      experimentIdentity: manifest.identity,
      slot,
      ordinal: 1,
      startedAt: '2026-01-01T00:00:00Z',
      completedAt: '2026-01-01T00:01:00Z',
      facts: {
        execution: { status: 'unknown' },
        captureStatus: 'unknown',
        traceStatus: 'unknown',
        mutation: null,
        grade: null,
      },
      outcome: {
        status,
        safety: 'unknown',
        isValidAttempt: status === 'passed',
      },
      usage: null,
      time: { agentMs: ms, endToEndMs: ms === null ? null : ms + 5 },
      activation: {
        installed: 'unknown',
        discovered: 'unknown',
        used: 'unknown',
      },
      evidence: [],
    });
    costs.push({
      runId,
      experimentIdentity: manifest.identity,
      taskId,
      condition,
      repetition: slot.repetition,
      traceSha256: null,
      observedUsd: usd ?? 0.002,
      totalUsd: usd,
      complete: usd !== null,
      pricedRequests: 1,
      unpricedRequests: usd === null ? 1 : 0,
      reason: usd === null ? 'partial' : null,
    });
  }
  add('I01', 'base', 10, 0.01, 'infra_error');
  add('I01', 'base', 30, null);
  attempts[1]!.ordinal = 2;
  attempts[1]!.replacementOf = attempts[0]!.runId;
  add('C01', 'base', 100, 0.1, 'assertion_failed');
  add('I01', 'skill', 40, 0, 'unknown');
  add('N01', 'base', 900, 9);
  return { manifest, attempts, costs };
}

test('measurement means weight task/condition cells, retain failed replacements, and separate controls', () => {
  const f = fixture();
  const m = buildCampaignMeasurements(f.manifest, f.attempts, f.costs);
  assert.equal(m.main.all.agentMs.mean, (20 + 100 + 40) / 3);
  assert.notEqual(m.main.all.agentMs.mean, (10 + 30 + 100 + 40) / 4);
  assert.equal(m.main.conditions.base!.agentMs.mean, 60);
  assert.equal(m.main.all.agentMs.executions, 4);
  assert.equal(m.main.all.agentMs.coverage, 1);
  assert.equal(m.negativeControls.all.agentMs.mean, 900);
  assert.equal(m.main.all.apiEquivalentUsd.mean, (0.01 + 0.1 + 0) / 3);
  assert.equal(m.main.all.apiEquivalentUsd.measured, 3);
  assert.equal(m.main.all.apiEquivalentUsd.coverage, 0.75);
  assert.equal(m.main.all.apiEquivalentUsd.total, null);
  assert.ok(Math.abs(m.main.all.apiEquivalentUsd.observedSum - 0.112) < 1e-12);
  assert.equal(m.main.all.settledUsd.mean, null);
  assert.equal(m.main.all.settledUsd.total, null);
});

test('missing timing and unsupported pricing stay unknown while evidenced zero remains a measurement', () => {
  const f = fixture();
  for (const a of f.attempts) {
    a.time = { agentMs: null, endToEndMs: null };
  }
  for (const c of f.costs) {
    c.complete = false;
    c.totalUsd = null;
    c.observedUsd = 0;
  }
  const m = buildCampaignMeasurements(f.manifest, f.attempts, f.costs);
  assert.equal(m.main.all.agentMs.mean, null);
  assert.equal(m.main.all.agentMs.coverage, 0);
  assert.equal(m.main.all.apiEquivalentUsd.mean, null);
  assert.equal(m.main.all.apiEquivalentUsd.total, null);
  assert.equal(m.main.all.apiEquivalentUsd.measuredCells, 0);
  assert.equal(m.main.all.apiEquivalentUsd.executions, 4);
  const empty = buildCampaignMeasurements(f.manifest, [], []);
  assert.equal(empty.main.all.agentMs.mean, null);
  assert.equal(empty.main.all.apiEquivalentUsd.total, null);
  assert.equal(empty.main.all.agentMs.cells, 32);
});

test('task input means retain partial usage and failures without double counting cache or weighting retries as cells', () => {
  const f = fixture();
  for (const [index, inputTokens] of [100, 900, 600, 0, 9000].entries()) {
    f.attempts[index]!.usage = {
      inputTokens,
      cachedInputTokens: inputTokens / 2,
      outputTokens: 10,
      credits: null,
      estimatedUsd: null,
      settledUsd: null,
      complete: index !== 1,
      settlement: 'unknown',
      source: 'offline-test',
    };
  }
  const m = buildCampaignMeasurements(f.manifest, f.attempts, f.costs);
  assert.equal(m.version, 2);
  const taskMetrics = m.tasks.find((t) => t.id === 'I01')!.all!;
  assert.equal(taskMetrics.inputTokens!.mean, 50); // Base 100, Skill evidenced zero.
  assert.equal(taskMetrics.inputTokens!.observedSum, 1000);
  assert.equal(taskMetrics.inputTokens!.total, null);
  assert.equal(taskMetrics.inputTokens!.measured, 2);
  assert.equal(taskMetrics.inputTokens!.executions, 3);
  assert.equal(taskMetrics.inputTokens!.coverage, 2 / 3);
  assert.equal(taskMetrics.agentMs.mean, 30); // (Base mean 20 + Skill 40) / 2.
  assert.equal(m.main.all.inputTokens!.mean, (100 + 600 + 0) / 3);
  assert.equal(m.negativeControls.all.inputTokens!.mean, 9000);
  // Token evidence is independent of whether a price is available.
  f.costs[2]!.complete = false;
  f.costs[2]!.totalUsd = null;
  assert.equal(
    buildCampaignMeasurements(f.manifest, f.attempts, f.costs).main.all
      .inputTokens!.mean,
    m.main.all.inputTokens!.mean,
  );
  const legacy = buildCampaignMeasurements(
    f.manifest,
    f.attempts,
    f.costs,
    undefined,
    1,
  );
  assert.equal(legacy.version, 1);
  assert.equal(Object.hasOwn(legacy.main.all, 'inputTokens'), false);
  assert.equal(Object.hasOwn(legacy.tasks[0]!, 'all'), false);
});

test('cost joins reject swapped cells, foreign models, omitted executions and trace identity drift', () => {
  const f = fixture();
  for (const changes of [
    { taskId: 'C01' },
    { condition: 'skill' },
    { repetition: 9 },
    { experimentIdentity: 'other' },
    { traceSha256: 'another' },
  ]) {
    const costs = structuredClone(f.costs);
    Object.assign(costs[0]!, changes);
    assert.throws(
      () => buildCampaignMeasurements(f.manifest, f.attempts, costs),
      /differs/,
    );
  }
  assert.throws(
    () => buildCampaignMeasurements(f.manifest, f.attempts, f.costs.slice(1)),
    /execution set/,
  );
  const attempts = structuredClone(f.attempts);
  attempts[0]!.modelProfileId = 'other';
  assert.throws(
    () => buildCampaignMeasurements(f.manifest, attempts, f.costs),
    /profile/,
  );
  attempts[0]!.modelProfileId = f.attempts[0]!.modelProfileId;
  attempts[0]!.time.agentMs = NaN;
  assert.throws(
    () => buildCampaignMeasurements(f.manifest, attempts, f.costs),
    /Invalid measurement/,
  );
});
