import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  contentIdentity,
  type LegacyCostReport as EstimatedCostReport,
} from './evals-public-protocol';
import {
  publicDevelopmentRetest,
  publicEstimatedCost,
  publicEvals,
  type DevelopmentRetestSummary,
  type EvalsAttempt,
  type EvalsSummary,
} from './export-evals';

it('exports API estimates separately from actual bills and binds every original and replacement attempt', () => {
  const { attempts } = fixture();
  for (const [index, row] of attempts.entries()) {
    row.runId = `synthetic-run-${index}`;
  }
  const rows = attempts.map((row, index) => ({
    runId: row.runId!,
    experimentIdentity: 'a'.repeat(64),
    taskId: row.taskId,
    condition: row.condition,
    repetition: row.repetition,
    traceSha256: 'b'.repeat(64),
    observedUsd: 0.01,
    totalUsd: index === 0 ? null : 0.01,
    pricedRequests: 1,
    unpricedRequests: index === 0 ? 1 : 0,
    complete: index !== 0,
    reason: index === 0 ? 'synthetic-incomplete' : null,
  }));
  const data = {
    version: 1 as const,
    kind: 'api-equivalent-estimate' as const,
    pricing: {
      version: 'synthetic-prices-v1',
      currency: 'USD' as const,
      observedOn: '2040-01-01',
      source: 'https://example.invalid/pricing',
    },
    pricingIdentity: contentIdentity({
      version: 'synthetic-prices-v1',
      currency: 'USD',
      observedOn: '2040-01-01',
      source: 'https://example.invalid/pricing',
    }),
    calculationIdentity: 'c'.repeat(64),
    sources: [],
    attempts: rows,
    summary: {
      observedUsd: rows.reduce((total, row) => total + row.observedUsd, 0),
      totalUsd: null,
      attempts: rows.length,
      completeAttempts: rows.length - 1,
      pricedRequests: rows.length,
      unpricedRequests: 1,
    },
  };
  const report: EstimatedCostReport = {
    ...data,
    identity: contentIdentity(data),
  };
  const result = publicEstimatedCost(report, attempts, 'e'.repeat(64));
  assert.equal(result.kind, 'api-equivalent-estimate');
  assert.equal(result.total.totalUsd, null);
  assert.equal(result.total.completeAttempts, attempts.length - 1);
  assert.ok(result.total.observedUsd > 0);
  assert.ok(attempts.every((row) => row.usage!.settledUsd === null));
  assert.ok(!JSON.stringify(result).includes('synthetic-run-'));
  assert.ok(!JSON.stringify(result).includes('traceSha256'));
  const wrong = structuredClone(attempts);
  wrong[0]!.runId = 'foreign-run';
  assert.throws(
    () => publicEstimatedCost(report, wrong, 'e'.repeat(64)),
    /match/,
  );
  const remapped = structuredClone(attempts);
  remapped[0]!.repetition = 2;
  remapped[1]!.outcome.status = 'unknown';
  remapped[1]!.traceStatus = 'partial';
  assert.throws(
    () => publicEstimatedCost(report, remapped, 'e'.repeat(64)),
    /match/,
  );
  assert.equal(
    publicEstimatedCost(report, remapped, 'e'.repeat(64), [
      {
        originalRunId: remapped[1]!.runId!,
        replacementRunId: remapped[0]!.runId!,
        taskId: remapped[0]!.taskId,
        condition: remapped[0]!.condition,
        repetition: 2,
        reason: 'native_trace_incomplete',
      },
    ]).total.attempts,
    attempts.length,
  );
  assert.throws(
    () =>
      publicEstimatedCost(
        { ...report, identity: 'f'.repeat(64) },
        attempts,
        'e'.repeat(64),
      ),
    /identity/,
  );
  const duplicates = { ...data, attempts: [...rows.slice(1), rows[1]!] };
  assert.throws(
    () =>
      publicEstimatedCost(
        { ...duplicates, identity: contentIdentity(duplicates) },
        attempts,
        'e'.repeat(64),
      ),
    /Duplicate/,
  );
});

// Synthetic reports exercise the publication contract, never model performance.
function metric(count: number) {
  return {
    observedSum: count * 100,
    observedCount: count,
    missingCount: 0,
    incompleteCount: 0,
    total: count * 100,
  };
}
function money(count: number) {
  return {
    observedSum: 0,
    observedCount: 0,
    missingCount: count,
    total: null,
  };
}
function fixture() {
  const groups = [
    ['I', 'initialization', 2],
    ['C', 'configuration', 3],
    ['R', 'reference-graph', 1],
    ['K', 'checker', 2],
    ['S', 'source-governance', 3],
    ['W', 'workflow', 1],
    ['T', 'troubleshooting', 2],
    ['P', 'package-release', 3],
  ] as const;
  const tasks: { id: string; domain: string; split: string }[] = groups.flatMap(
    ([prefix, domain, sealed]) =>
      [1, 2, 3].map((number) => ({
        id: `${prefix}0${number}`,
        domain,
        split: number === sealed ? 'sealed' : 'development',
      })),
  );
  tasks.push(
    { id: 'N01', domain: 'negative-control', split: 'development' },
    { id: 'N02', domain: 'negative-control', split: 'sealed' },
  );
  const attempts: EvalsAttempt[] = tasks.flatMap((task) =>
    ['base', 'skill'].flatMap((condition) =>
      [1, 2, 3].map((repetition) => ({
        batch: task.split,
        condition,
        taskId: task.id,
        repetition,
        executionStatus: 'completed',
        executionExitCode: 0,
        captureStatus: 'complete',
        traceStatus: 'complete',
        mutationStatus: 'accepted',
        gradeStatus: 'complete',
        outcome: {
          status:
            condition === 'skill' && repetition < 3 && task.id === 'I03'
              ? 'assertion_failed'
              : 'passed',
          isValidAttempt: true,
          safety: 'safe',
        },
        time: { agentMs: condition === 'base' ? 1000 : 2000, endToEndMs: 3000 },
        usage: {
          tokenUsageComplete: true,
          financialEvidenceKind: null,
          settledUsd: null,
          settlement: 'unknown',
        },
      })),
    ),
  );
  const batch = (split: 'development' | 'sealed') => {
    const selected = tasks.filter((task) => task.split === split);
    return {
      plannedSlots: selected.length * 6,
      recordedAttempts: selected.length * 6,
      provisional: false,
      conditions: ['base', 'skill'].map((id) => ({
        id,
        macroPassRate: split === 'development' && id === 'skill' ? 23 / 24 : 1,
        tasks: selected.map((task) => ({
          taskId: task.id,
          domain: task.domain,
          planned: 3,
          valid: 3,
          passed: id === 'skill' && task.id === 'I03' ? 1 : 3,
          rate: id === 'skill' && task.id === 'I03' ? 1 / 3 : 1,
          interval95: null,
        })),
        usage: {
          records: selected.length * 3,
          completeRecords: selected.length * 3,
          inputTokens: metric(selected.length * 3),
          cachedInputTokens: metric(selected.length * 3),
          outputTokens: metric(selected.length * 3),
          settledUsd: money(selected.length * 3),
        },
      })),
      comparisons: [
        {
          condition: 'skill',
          macro: {
            liftPercentagePoints: split === 'development' ? -100 / 24 : 0,
            regression: split === 'development' ? 1 / 24 : 0,
          },
          excludedPairs: [],
          bootstrap: {
            resamples: 10_000,
            liftInterval95PercentagePoints: [-11, 0] as [number, number],
            regressionInterval95: [0, 0.11] as [number, number],
          },
        },
      ],
    };
  };
  const summary: EvalsSummary = {
    createdAt: '2026-11-05T23:37:59.399Z',
    model: 'gpt-6.1-terra',
    reasoningEffort: 'high',
    speed: 'standard',
    productInputIdentity: 'a'.repeat(64),
    skillDigest: 'b'.repeat(64),
    registeredComparisonSlots: 156,
    recordedComparisonAttempts: 156,
    comparisonEvidenceProvisional: false,
    significantImprovementClaim: false,
    batches: { development: batch('development'), sealed: batch('sealed') },
  };
  return { summary, attempts };
}

it('preserves independent failures, domain weighting, split boundaries and negative controls', () => {
  const { summary, attempts } = fixture();
  const result = publicEvals(summary, attempts, 'c'.repeat(64));
  assert.equal(result.taskCount, 26);
  assert.equal(result.comparisonAttempts, 156);
  assert.equal(result.measuredOn, '2026-11-06');
  assert.equal(
    result.batches.development.conditions.skill.macroPassRate,
    23 / 24,
  );
  assert.equal(result.batches.sealed.conditions.skill.macroPassRate, 1);
  const index03 = result.batches.development.domains
    .flatMap((domain) => domain.tasks)
    .find((task) => task.id === 'I03')!;
  assert.equal(index03.skill.passed, 1);
  assert.equal(index03.skill.attempts, 3);
  assert.equal(index03.skill.rate, 1 / 3);
  assert.equal(result.batches.development.negativeControls[0]?.id, 'N01');
  assert.equal(result.batches.sealed.negativeControls[0]?.id, 'N02');
  assert.equal(result.batches.development.conditions.base.meanAgentMs, 1000);
  assert.equal(result.batches.development.conditions.skill.meanAgentMs, 2000);
});

function retestFixture(): {
  source: DevelopmentRetestSummary;
  attempts: EvalsAttempt[];
} {
  const { summary, attempts } = fixture();
  const { batches, ...metadata } = summary;
  const source: DevelopmentRetestSummary = {
    ...metadata,
    registeredComparisonSlots: 102,
    recordedComparisonAttempts: 102,
    experimentIdentity: 'd'.repeat(64),
    parentSummarySha256: 'e'.repeat(64),
    gradingResolution: {
      identity: 'a'.repeat(64),
      initialErrors: 0,
      reassessedTasks: [],
      reassessedAttempts: 0,
      additionalGradingMs: 0,
    },
    executionResolution: {
      identity: 'b'.repeat(64),
      initialUnknowns: 0,
      replacements: [],
    },
    development: batches.development,
  };
  return {
    source,
    attempts: attempts
      .filter((row) => row.batch === 'development')
      .map((row, index) => ({
        ...row,
        runId: index.toString(16).padStart(64, '0') + '-1',
        selectedForComparison: true,
      })),
  };
}

it('publishes a complete retest separately and retains failures instead of forcing 100%', () => {
  const { source, attempts } = retestFixture();
  const before = structuredClone(source);
  Object.assign(source, {
    privatePath: 'synthetic-private-path',
    hiddenGrader: 'synthetic-private-grader',
  });
  const result = publicDevelopmentRetest(source, attempts, 'f'.repeat(64));
  assert.equal(result.originalResultsReplaced, false);
  assert.equal(result.comparisonAttempts, 102);
  assert.equal(result.repetitions, 3);
  assert.equal(result.batch.conditions.skill.macroPassRate, 23 / 24);
  assert.equal(
    result.batch.domains.flatMap((d) => d.tasks).find((t) => t.id === 'I03')!
      .skill.passed,
    1,
  );
  assert.equal(result.batch.negativeControls.length, 1);
  assert.deepEqual(source.development, before.development);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-private|sealed/u);
});

it('rejects incomplete or mixed retest cohorts before publishing an overall score', () => {
  const cases: ((s: DevelopmentRetestSummary, a: EvalsAttempt[]) => void)[] = [
    (s) => {
      s.comparisonEvidenceProvisional = true;
    },
    (_, a) => {
      a.pop();
    },
    (_, a) => {
      a[0]!.batch = 'sealed';
    },
    (_, a) => {
      a[0]!.captureStatus = 'unknown';
    },
    (_, a) => {
      a[1] = structuredClone(a[0]!);
    },
    (s) => {
      s.registeredComparisonSlots = 6;
    },
  ];
  for (const change of cases) {
    const { source, attempts } = retestFixture();
    change(source, attempts);
    assert.throws(() =>
      publicDevelopmentRetest(source, attempts, 'f'.repeat(64)),
    );
  }
});

it('retains an infrastructure observation and all its usage without inflating the comparison sample', () => {
  const { source, attempts } = retestFixture();
  const replacement = attempts.find(
    (row) =>
      row.taskId === 'P01' && row.condition === 'skill' && row.repetition === 3,
  )!;
  const original: EvalsAttempt = {
    ...structuredClone(replacement),
    runId: 'f'.repeat(64) + '-1',
    selectedForComparison: false,
    traceStatus: 'partial',
    outcome: { status: 'unknown', isValidAttempt: false, safety: 'safe' },
    time: { agentMs: 12_000, endToEndMs: 15_000 },
    usage: { ...replacement.usage!, tokenUsageComplete: false },
  };
  attempts.push(original);
  source.recordedComparisonAttempts++;
  source.development.recordedAttempts++;
  source.executionResolution.initialUnknowns = 1;
  source.executionResolution.replacements.push({
    originalRunId: original.runId!,
    replacementRunId: replacement.runId!,
    taskId: 'P01',
    condition: 'skill',
    repetition: 3,
    reason: 'native_trace_incomplete',
  });
  const usage = source.development.conditions.find(
    (c) => c.id === 'skill',
  )!.usage;
  usage.records++;
  for (const name of [
    'inputTokens',
    'cachedInputTokens',
    'outputTokens',
  ] as const) {
    usage[name].observedSum += 100;
    usage[name].observedCount++;
    usage[name].incompleteCount = 1;
    usage[name].total = null;
  }
  usage.settledUsd.missingCount++;
  const result = publicDevelopmentRetest(source, attempts, 'f'.repeat(64));
  assert.equal(result.comparisonAttempts, 102);
  assert.equal(result.recordedAttempts, 103);
  assert.equal(result.executionResolution.replacementAttempts, 1);
  assert.equal(result.batch.conditions.skill.attempts, 52);
  assert.equal(
    result.batch.conditions.skill.meanAgentMs,
    (51 * 2000 + 12_000) / 52,
  );
  assert.equal(result.batch.conditions.skill.input.observed, 5200);
  assert.equal(result.batch.conditions.skill.input.total, null);
  assert.equal(result.batch.conditions.skill.actualMeanUsd, null);
  assert.equal(result.batch.conditions.skill.macroPassRate, 23 / 24);
  original.outcome.status = 'agent_error';
  original.outcome.isValidAttempt = true;
  assert.throws(
    () => publicDevelopmentRetest(source, attempts, 'f'.repeat(64)),
    /Cannot replace a known Agent failure/u,
  );
});

it('does not include injected private fields in the public projection', () => {
  const { summary, attempts } = fixture();
  const canary = 'synthetic-private-evals-canary';
  Object.assign(summary, {
    hiddenGrader: canary,
    referenceSolution: canary,
    controllerHome: canary,
    financial: { purchaseLimit: canary },
  });
  Object.assign(summary.batches.sealed.conditions[0]!.tasks[0]!, {
    prompt: canary,
  });
  Object.assign(attempts[0]!, {
    runId: canary,
    evidence: canary,
    rawTrace: canary,
  });
  const result = publicEvals(summary, attempts, 'c'.repeat(64));
  assert.ok(!JSON.stringify(result).includes(canary));
});

it('keeps observed tokens separate from complete totals and rejects inferred zero bills', () => {
  const { summary, attempts } = fixture();
  const source = summary.batches.development.conditions[0]!;
  const row = attempts.find(
    (value) => value.batch === 'development' && value.condition === 'base',
  )!;
  row.usage!.tokenUsageComplete = false;
  source.usage.completeRecords--;
  for (const key of [
    'inputTokens',
    'cachedInputTokens',
    'outputTokens',
  ] as const) {
    source.usage[key].incompleteCount = 1;
    source.usage[key].total = null;
  }
  const result = publicEvals(summary, attempts, 'c'.repeat(64)).batches
    .development.conditions.base;
  assert.equal(result.input.observed, 5100);
  assert.equal(result.input.total, null);
  assert.equal(result.usageComplete, 50);
  assert.equal(result.actualMeanUsd, null);
  source.usage.settledUsd.total = 0;
  assert.throws(
    () => publicEvals(summary, attempts, 'c'.repeat(64)),
    /Money needs independent settlement evidence/u,
  );
});

it('rejects unknown final state and missing or duplicated repetitions', () => {
  for (const dimension of [
    'unknown-state',
    'missing-attempt',
    'duplicate-attempt',
  ]) {
    const { summary, attempts } = fixture();
    if (dimension === 'unknown-state') attempts[0]!.captureStatus = 'unknown';
    else if (dimension === 'missing-attempt') attempts.pop();
    else attempts[1] = structuredClone(attempts[0]!);
    assert.throws(
      () => publicEvals(summary, attempts, 'c'.repeat(64)),
      /Incomplete state|Incomplete registered|Duplicate independent/u,
    );
  }
});

it('refuses a mismatched source hash before writing a public file', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'limina-evals-export-'));
  const output = path.join(root, 'public.json');
  try {
    await writeFile(
      path.join(root, 'summary.json'),
      JSON.stringify(fixture().summary),
    );
    const script = fileURLToPath(new URL('export-evals.ts', import.meta.url));
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        script,
        root,
        '0'.repeat(64),
        output,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Summary integrity differs/u);
    assert.equal(existsSync(output), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
