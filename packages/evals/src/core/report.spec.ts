import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BudgetManager, UsageRecord } from './budget.ts';
import { createExperiment, taskCatalog } from './experiment.ts';
import { contentIdentity } from './identity.ts';
import type { OutcomeStatus } from './outcome.ts';
import { buildReport, summarizeUsage } from './report.ts';
import type { AttemptRecord, RunStore } from './run-store.ts';

type Summary = ReturnType<RunStore['summary']>;

test('reported partial token counts remain observed sums with unknown complete totals', () => {
  const report = summarizeUsage([
    {
      inputTokens: 100,
      cachedInputTokens: 70,
      outputTokens: 10,
      credits: null,
      estimatedUsd: null,
      settledUsd: null,
      source: 'synthetic CLI-reported counters',
      complete: false,
      settlement: 'unknown',
    },
  ]);
  assert.equal(report.inputTokens.observedSum, 100);
  assert.equal(report.cachedInputTokens.observedSum, 70);
  assert.equal(report.outputTokens.observedSum, 10);
  assert.equal(report.inputTokens.total, null);
  assert.equal(report.cachedInputTokens.total, null);
  assert.equal(report.outputTokens.total, null);
  assert.equal(report.completeRecords, 0);
  assert.equal(report.settledUsd.total, null);
});
const emptyBudget: ReturnType<BudgetManager['summary']> = {
  currency: 'USD',
  totalLimit: 100,
  reserve: 15,
  committedSpend: 0,
  settledSpend: 0,
  estimatedSpend: null,
  remainingBudget: 100,
  observedSettledSpend: 0,
  financialUnknownRecords: 0,
  maximumExposure: 0,
  remainingAuthorization: 100,
  includedDispatchReady: true,
  attempts: [],
};
function budgetFor(summary: Summary): ReturnType<BudgetManager['summary']> {
  return {
    ...emptyBudget,
    attempts: summary.attempts.map((attempt) => ({
      reservation: {
        runId: attempt.runId,
        taskId: attempt.slot.taskId,
        model: 'gpt-6.1-terra',
        reasoningEffort: 'high',
        speed: 'standard',
        maximumUsd: 0,
        estimatedUsd: null,
        billing: {
          mode: 'included_only',
          observedAt: '2026-01-01T00:00:00Z',
          source: 'synthetic offline budget',
          ordinaryUsageAllowed: true,
          autoReloadDisabled: true,
          creditBalance: 0,
          rateCardVersion: null,
          providerEnforcedCeilingUsd: null,
        },
      },
      usage: attempt.usage,
      notDispatchedEvidence: null,
    })),
  };
}
function fixture() {
  const fixed = contentIdentity('synthetic offline report input');
  const manifest = createExperiment({
    kind: 'development',
    seed: 'fixed-report-seed',
    preparedInputsDigest: fixed,
    runnerDigest: fixed,
    toolchainDigest: fixed,
    contextDigest: fixed,
    imageDigest: fixed,
    tasks: taskCatalog
      .filter((task) => task.split === 'dev')
      .map((task) => ({
        ...task,
        specDigest: fixed,
        executionDigest: fixed,
        gradingDigest: fixed,
      })),
    conditions: [
      { id: 'base', skillDigest: null },
      { id: 'skill', skillDigest: fixed },
    ],
  });
  const attempts: AttemptRecord[] = manifest.slots.map((slot) => ({
    version: 1,
    runId: `${slot.id}-1`,
    experimentIdentity: manifest.identity,
    slot,
    ordinal: 1,
    startedAt: '2026-01-01T00:00:00Z',
    completedAt: '2026-01-01T00:00:01Z',
    facts: {
      execution: { status: 'completed', exitCode: 0 },
      captureStatus: 'complete',
      traceStatus: 'complete',
      mutation: {
        status: 'accepted',
        changes: [],
        dependencyVariant: {
          id: 'synthetic',
          inputsDigest: fixed,
          closureDigest: fixed,
        },
      },
      grade: {
        taskId: slot.taskId,
        graderDigest: fixed,
        status: 'complete',
        assertions: [{ id: 'synthetic', passed: true }],
      },
    },
    outcome: { status: 'passed', isValidAttempt: true, safety: 'safe' },
    usage: null,
    time: { agentMs: 1000, endToEndMs: 1200 },
    activation: {
      installed: 'unknown',
      discovered: 'unknown',
      used: 'unknown',
    },
    evidence: [],
  }));
  const summary: Summary = {
    experimentIdentity: manifest.identity,
    attempts,
    attemptEvidence: attempts.map((attempt) => ({
      runId: attempt.runId,
      status: 'complete',
    })),
    inFlight: null,
    slots: attempts.map((selected) => ({
      slot: selected.slot,
      selected,
      evidenceStatus: 'complete',
      status: 'passed',
    })),
  };
  function status(
    task: string,
    condition: string,
    repetition: number,
    value: OutcomeStatus,
  ) {
    const slot = summary.slots.find(
      (slot) =>
        slot.slot.taskId === task &&
        slot.slot.condition === condition &&
        slot.slot.repetition === repetition,
    )!;
    slot.status = value;
    slot.selected!.outcome.status = value;
    return slot;
  }
  return { manifest, summary, status };
}

test('report weights tasks then eight domains, excludes controls, and bootstraps reproducibly', () => {
  const f = fixture();
  for (const repetition of [1, 2, 3]) {
    f.status('I03', 'skill', repetition, 'assertion_failed');
    f.status('N01', 'skill', repetition, 'assertion_failed');
  }
  f.status('I01', 'skill', 2, 'unknown');
  f.status('I01', 'skill', 3, 'unknown');
  const report = buildReport(f.manifest, f.summary, budgetFor(f.summary));
  const skill = report.conditions.find(
    (condition) => condition.id === 'skill',
  )!;
  assert.equal(
    skill.domains.find((domain) => domain.domain === 'initialization')!.rate,
    0.5,
  );
  assert.equal(skill.macroPassRate, 0.9375);
  assert.equal(skill.negativeControl[0]!.rate, 0);
  assert.equal(skill.tasks.find((task) => task.taskId === 'I01')!.valid, 1);
  assert.equal(report.comparisons[0]!.macro!.liftPercentagePoints, -6.25);
  assert.equal(report.comparisons[0]!.macro!.regression, 0.0625);
  assert.equal(report.comparisons[0]!.bootstrap!.resamples, 10_000);
  assert.equal(report.comparisons[0]!.significantImprovementClaim, false);
  assert.equal(report.provisional, true);
  const repeated = buildReport(f.manifest, f.summary, budgetFor(f.summary));
  assert.deepEqual(
    repeated.comparisons[0]!.bootstrap,
    report.comparisons[0]!.bootstrap,
  );
  assert.deepEqual(
    report.bySplit.map((group) => [group.split, group.plannedSlots]),
    [['dev', 102]],
  );
  assert.ok(skill.tasks[0]!.interval95);
});

test('asymmetric infrastructure, lost state and unexecuted slots cannot become an improved complete comparison', () => {
  const f = fixture();
  f.status('I01', 'base', 1, 'infra_error');
  const error = f.status('I01', 'skill', 2, 'agent_error');
  error.evidenceStatus = 'unknown';
  error.selected!.facts.captureStatus = 'unknown';
  error.selected!.facts.execution = { status: 'error' };
  const unrun = f.status('I01', 'skill', 3, 'not_run');
  unrun.selected = null;
  const report = buildReport(f.manifest, f.summary, budgetFor(f.summary));
  const skill = report.conditions.find(
    (condition) => condition.id === 'skill',
  )!;
  assert.equal(report.provisional, true);
  assert.equal(report.comparisons[0]!.excludedPairs.length, 2);
  assert.equal(report.comparisons[0]!.provisional, true);
  const task = skill.tasks.find((task) => task.taskId === 'I01')!;
  assert.equal(task.valid, 2);
  assert.equal(task.rate, 0.5);
  assert.equal(task.statuses.not_run, 1);
  assert.equal(skill.unsafeMutation.unknown, 1);
  assert.equal(skill.activation.used.yes, 0);
  const altered = structuredClone(f.summary);
  altered.slots[0]!.slot.gradingIdentity = contentIdentity('different grader');
  assert.throws(
    () => buildReport(f.manifest, altered, budgetFor(f.summary)),
    /frozen experiment/,
  );
});

test('usage preserves unknowns and counts failed/replacement work without adding cached tokens twice', () => {
  const known: UsageRecord = {
    inputTokens: 100,
    cachedInputTokens: 70,
    outputTokens: 10,
    credits: null,
    estimatedUsd: null,
    settledUsd: 0,
    source: 'synthetic offline usage',
    complete: true,
    settlement: 'included',
  };
  const totals = summarizeUsage([
    known,
    { ...known, inputTokens: 200, cachedInputTokens: 150 },
    null,
  ]);
  assert.equal(totals.inputTokens.total, null);
  assert.equal(totals.inputTokens.observedSum, 300);
  assert.equal(totals.cachedInputTokens.observedSum, 220);
  assert.equal(totals.outputTokens.observedSum, 20);
  assert.equal(totals.inputTokens.missingCount, 1);
  assert.equal(totals.credits.total, null);
  assert.equal(totals.estimatedUsd.total, null);
  assert.equal(totals.settlement.unknown, 3);
  assert.equal(totals.settledUsd.total, null);
  const f = fixture();
  for (const attempt of f.summary.attempts) attempt.usage = known;
  const replacement = structuredClone(f.summary.attempts[0]!);
  replacement.ordinal = 2;
  replacement.runId = `${replacement.slot.id}-2`;
  f.summary.attempts[0]!.outcome.status = 'infra_error';
  f.summary.attempts.push(replacement);
  f.summary.attemptEvidence.push({
    runId: replacement.runId,
    status: 'complete',
  });
  f.summary.attempts[0]!.outcome.safety = 'unsafe';
  const report = buildReport(f.manifest, f.summary, budgetFor(f.summary));
  assert.equal(report.recordedAttempts, 103);
  assert.equal(report.plannedSlots, 102);
  assert.equal(report.usage.inputTokens.total, 10_300);
  assert.equal(report.usage.cachedInputTokens.total, 7210);
  assert.equal(report.usage.settledUsd.total, null);
  assert.equal(report.budget.settledSpend, null);
  assert.equal(report.budget.remainingBudget, null);
  assert.equal(report.budget.financialUnknownRecords, 103);
  assert.equal(report.financialProvisional, true);
  assert.equal(report.usage.credits.total, null);
  const condition = report.conditions.find(
    (value) => value.id === replacement.slot.condition,
  )!;
  assert.equal(condition.allAttemptUnsafeMutation.observedUnsafe, 1);
  assert.equal(condition.allAttemptUnsafeMutation.determinable, 52);
  assert.equal(condition.usage.records, 52);
  assert.throws(
    () => buildReport(f.manifest, f.summary, emptyBudget),
    /shared budget ledger/,
  );
  const wrongUsage = budgetFor(f.summary);
  wrongUsage.attempts[0]!.usage = { ...known, inputTokens: 101 };
  assert.throws(
    () => buildReport(f.manifest, f.summary, wrongUsage),
    /usage disagrees/,
  );
  assert.equal(
    JSON.stringify(report).includes('synthetic offline usage'),
    false,
  );
});
