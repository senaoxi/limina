import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'prettier';
import {
  contentIdentity,
  summarizeCosts,
  type LegacyCostReport as EstimatedCostReport,
} from './evals-public-protocol';

const domains = [
  'initialization',
  'configuration',
  'reference-graph',
  'checker',
  'source-governance',
  'workflow',
  'troubleshooting',
  'package-release',
];
const conditions = ['base', 'skill'] as const;
type Condition = (typeof conditions)[number];
type Split = 'development' | 'sealed';
interface Measurement {
  observedSum: number;
  observedCount: number;
  missingCount: number;
  incompleteCount?: number;
  total: number | null;
}
interface Task {
  taskId: string;
  domain: string;
  planned: number;
  valid: number;
  passed: number;
  rate: number;
  interval95: [number, number] | null;
}
interface SourceCondition {
  id: string;
  tasks: Task[];
  macroPassRate: number;
  usage: {
    records: number;
    completeRecords: number;
    inputTokens: Measurement;
    cachedInputTokens: Measurement;
    outputTokens: Measurement;
    settledUsd: Measurement;
  };
}
export interface EvalsSummary {
  createdAt: string;
  model: string;
  reasoningEffort: string;
  speed: string;
  productInputIdentity: string;
  skillDigest: string;
  registeredComparisonSlots: number;
  recordedComparisonAttempts: number;
  comparisonEvidenceProvisional: boolean;
  significantImprovementClaim: boolean;
  batches: Record<
    Split,
    {
      plannedSlots: number;
      recordedAttempts: number;
      provisional: boolean;
      conditions: SourceCondition[];
      comparisons: {
        condition: string;
        macro: { liftPercentagePoints: number; regression: number };
        excludedPairs: unknown[];
        bootstrap: {
          resamples: number;
          liftInterval95PercentagePoints: [number, number];
          regressionInterval95: [number, number];
        };
      }[];
    }
  >;
}
export interface EvalsAttempt {
  runId?: string;
  selectedForComparison?: boolean;
  batch: string;
  condition: string;
  taskId: string;
  repetition: number;
  executionStatus: string;
  executionExitCode: number | null;
  captureStatus: string;
  traceStatus: string;
  mutationStatus: string;
  gradeStatus: string;
  outcome: { status: string; isValidAttempt: boolean; safety: string };
  time: { agentMs: number | null; endToEndMs: number | null };
  usage: {
    tokenUsageComplete: boolean;
    financialEvidenceKind: string | null;
    settledUsd: number | null;
    settlement: string;
  } | null;
}

export interface DevelopmentRetestSummary
  extends Omit<EvalsSummary, 'batches'> {
  experimentIdentity: string;
  parentSummarySha256: string;
  development: EvalsSummary['batches']['development'];
  gradingResolution: {
    identity: string;
    initialErrors: number;
    reassessedTasks: string[];
    reassessedAttempts: number;
    additionalGradingMs: number;
  };
  executionResolution: {
    identity: string;
    initialUnknowns: number;
    replacements: {
      originalRunId: string;
      replacementRunId: string;
      taskId: string;
      condition: string;
      repetition: number;
      reason: 'native_trace_incomplete';
    }[];
  };
}

/**
Public allowlist: no request identities, trace contents or controller paths.
*/
export function publicEstimatedCost(
  report: EstimatedCostReport,
  attempts: EvalsAttempt[],
  expectedSha256: string,
  replacements: DevelopmentRetestSummary['executionResolution']['replacements'] = [],
) {
  const { identity, ...data } = report;
  assert.equal(identity, contentIdentity(data), 'Cost report identity differs');
  assert.equal(report.version, 1);
  assert.equal(report.kind, 'api-equivalent-estimate');
  assert.equal(report.pricing.currency, 'USD');
  assert.equal(
    report.pricingIdentity,
    contentIdentity(report.pricing),
    'Cost pricing identity differs',
  );
  assert.equal(
    report.attempts.length,
    attempts.length,
    'Cost attempt coverage differs',
  );
  const byId = new Map(report.attempts.map((row) => [row.runId, row]));
  assert.equal(byId.size, attempts.length, 'Duplicate cost attempts');
  for (const row of attempts) {
    const cost = row.runId ? byId.get(row.runId) : undefined;
    const replacement = replacements.find(
      (value) => value.replacementRunId === row.runId,
    );
    const original = replacement
      ? attempts.find((value) => value.runId === replacement.originalRunId)
      : undefined;
    const mappedRepetition =
      replacement &&
      original &&
      original.runId !== row.runId &&
      original.outcome.status === 'unknown' &&
      original.traceStatus !== 'complete' &&
      replacement.reason === 'native_trace_incomplete' &&
      replacement.taskId === row.taskId &&
      replacement.condition === row.condition &&
      replacement.repetition === row.repetition &&
      original.taskId === row.taskId &&
      original.condition === row.condition &&
      original.repetition === row.repetition;
    assert.ok(
      cost &&
        cost.taskId === row.taskId &&
        cost.condition === row.condition &&
        (cost.repetition === row.repetition || mappedRepetition),
      'Cost does not match the evaluated attempts',
    );
    assert.ok(
      Number.isFinite(cost.observedUsd) &&
        cost.observedUsd >= 0 &&
        Number.isSafeInteger(cost.pricedRequests) &&
        cost.pricedRequests >= 0 &&
        Number.isSafeInteger(cost.unpricedRequests) &&
        cost.unpricedRequests >= 0,
      'Invalid cost measurement',
    );
    assert.ok(
      cost.complete
        ? cost.totalUsd === cost.observedUsd && cost.unpricedRequests === 0
        : cost.totalUsd === null,
      'Invalid cost completeness',
    );
  }
  return {
    kind: 'api-equivalent-estimate' as const,
    currency: 'USD' as const,
    sourceSha256: digest(expectedSha256),
    pricingIdentity: report.pricingIdentity,
    pricingVersion: report.pricing.version,
    observedOn: report.pricing.observedOn,
    source: report.pricing.source,
    total: summarizeCosts(report.attempts),
    conditions: Object.fromEntries(
      conditions.map((id) => [
        id,
        summarizeCosts(report.attempts.filter((row) => row.condition === id)),
      ]),
    ) as Record<Condition, ReturnType<typeof summarizeCosts>>,
  };
}

function mean(values: number[]): number {
  assert.ok(values.length > 0, 'Missing observations');
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
function close(actual: number, expected: number): void {
  assert.ok(
    Number.isFinite(actual) && Math.abs(actual - expected) < 1e-9,
    'Inconsistent metric',
  );
}
function digest(value: string): string {
  assert.ok(/^[a-f\d]{64}$/u.test(value), 'Invalid content identity');
  return value;
}
function interval(values: [number, number] | null) {
  if (values === null) return null;
  assert.ok(
    values.length === 2 &&
      values.every(Number.isFinite) &&
      values[0] <= values[1],
    'Invalid interval',
  );
  return [values[0], values[1]];
}
function averageTime(rows: EvalsAttempt[], key: 'agentMs' | 'endToEndMs') {
  const values = rows.map((row) => row.time[key]);
  assert.ok(
    values.every(
      (value) => value === null || (Number.isFinite(value) && value >= 0),
    ),
    'Invalid duration',
  );
  return values.includes(null) ? null : mean(values.map((value) => value!));
}
function observation(metric: Measurement) {
  for (const value of [
    metric.observedSum,
    metric.observedCount,
    metric.missingCount,
    metric.incompleteCount ?? 0,
  ])
    assert.ok(Number.isFinite(value) && value >= 0, 'Invalid usage coverage');
  if (metric.missingCount || metric.incompleteCount)
    assert.ok(
      metric.total === null,
      'Incomplete usage must not become a complete total',
    );
  else close(metric.total!, metric.observedSum);
  return {
    observed: metric.observedSum,
    total: metric.total,
    missing: metric.missingCount,
    partial: metric.incompleteCount ?? 0,
  };
}
function checkRows(rows: EvalsAttempt[]): void {
  const keys = rows.map(
    (row) => `${row.batch}/${row.condition}/${row.taskId}/${row.repetition}`,
  );
  assert.ok(
    new Set(keys).size === keys.length,
    'Duplicate independent attempt',
  );
  for (const row of rows) {
    assert.ok(
      row.outcome.isValidAttempt,
      'Cannot publish an incomplete comparison',
    );
    assert.ok(
      row.captureStatus === 'complete' && row.traceStatus === 'complete',
      'Incomplete state or trace',
    );
    if (row.outcome.status !== 'passed') continue;
    assert.ok(
      row.executionStatus === 'completed' && row.executionExitCode === 0,
      'False successful exit',
    );
    assert.ok(
      row.mutationStatus === 'accepted' &&
        row.gradeStatus === 'complete' &&
        row.outcome.safety === 'safe',
      'False successful grade',
    );
  }
}
function taskResult(task: Task, rows: EvalsAttempt[]) {
  assert.ok(/^[A-Z]\d{2}$/u.test(task.taskId), 'Invalid public task ID');
  assert.ok(
    domains.includes(task.domain) || task.domain === 'negative-control',
    'Invalid domain',
  );
  assert.ok(
    rows.length === task.planned && task.planned === 3 && task.valid === 3,
    'Missing registered repetitions',
  );
  const passed = rows.filter((row) => row.outcome.status === 'passed').length;
  assert.ok(passed === task.passed, 'Task pass count disagrees with attempts');
  close(task.rate, passed / rows.length);
  return {
    passed,
    attempts: rows.length,
    rate: task.rate,
    interval95: interval(task.interval95),
    meanAgentMs: averageTime(rows, 'agentMs'),
  };
}
function conditionResult(
  source: SourceCondition,
  rows: EvalsAttempt[],
  measurements: EvalsAttempt[] = rows,
) {
  assert.ok(
    source.usage.records === measurements.length,
    'Usage record count differs',
  );
  assert.ok(
    source.usage.completeRecords ===
      measurements.filter((row) => row.usage?.tokenUsageComplete).length,
    'Usage completeness differs',
  );
  const main = source.tasks.filter(
    (task) => task.domain !== 'negative-control',
  );
  const rate = mean(
    domains.map((domain) => {
      const tasks = main.filter((task) => task.domain === domain);
      assert.ok(tasks.length, 'Missing Limina domain');
      return mean(tasks.map((task) => task.rate));
    }),
  );
  close(source.macroPassRate, rate);
  const actualUsd = source.usage.settledUsd.total;
  if (actualUsd !== null) {
    assert.ok(
      measurements.every(
        (row) =>
          row.usage?.financialEvidenceKind &&
          row.usage.settledUsd !== null &&
          ['included', 'settled'].includes(row.usage.settlement),
      ),
      'Money needs independent settlement evidence',
    );
    close(
      actualUsd,
      measurements.reduce((sum, row) => sum + row.usage!.settledUsd!, 0),
    );
  }
  return {
    macroPassRate: source.macroPassRate,
    attempts: measurements.length,
    passed: source.tasks.reduce((sum, task) => sum + task.passed, 0),
    mainPassed: main.reduce((sum, task) => sum + task.passed, 0),
    mainAttempts: main.reduce((sum, task) => sum + task.valid, 0),
    meanAgentMs: averageTime(measurements, 'agentMs'),
    meanEndToEndMs: averageTime(measurements, 'endToEndMs'),
    input: observation(source.usage.inputTokens),
    cachedInput: observation(source.usage.cachedInputTokens),
    output: observation(source.usage.outputTokens),
    usageComplete: source.usage.completeRecords,
    actualMeanUsd: actualUsd === null ? null : actualUsd / measurements.length,
  };
}
function batchResult(
  source: EvalsSummary['batches'][Split],
  records: EvalsAttempt[],
  split: Split,
  measurements: EvalsAttempt[] = records,
) {
  assert.ok(!source.provisional, 'Batch is provisional');
  assert.ok(
    source.conditions.length === 2,
    'Expected Base and Skill conditions',
  );
  const rows = records.filter((row) => row.batch === split);
  const measured = measurements.filter((row) => row.batch === split);
  assert.ok(
    rows.length === source.plannedSlots &&
      source.recordedAttempts === measured.length,
    'Incomplete registered batch',
  );
  checkRows(rows);
  const entries = conditions.map((id) => {
    const value = source.conditions.find((condition) => condition.id === id);
    assert.ok(value, 'Missing comparison condition');
    return [id, value] as const;
  });
  const byCondition = Object.fromEntries(entries) as Record<
    Condition,
    SourceCondition
  >;
  const ids = byCondition.base.tasks
    .map((task) => task.taskId)
    .toSorted((left, right) => left.localeCompare(right));
  assert.ok(new Set(ids).size === ids.length, 'Duplicate task');
  assert.deepEqual(
    ids,
    byCondition.skill.tasks
      .map((task) => task.taskId)
      .toSorted((left, right) => left.localeCompare(right)),
    'Conditions use different tasks',
  );
  const tasks = byCondition.base.tasks.map((task) => {
    const skill = byCondition.skill.tasks.find(
      (value) => value.taskId === task.taskId,
    )!;
    assert.ok(skill.domain === task.domain, 'Task domains differ');
    return {
      id: task.taskId,
      domain: task.domain,
      base: taskResult(
        task,
        rows.filter(
          (row) => row.taskId === task.taskId && row.condition === 'base',
        ),
      ),
      skill: taskResult(
        skill,
        rows.filter(
          (row) => row.taskId === task.taskId && row.condition === 'skill',
        ),
      ),
    };
  });
  const base = conditionResult(
    byCondition.base,
    rows.filter((row) => row.condition === 'base'),
    measured.filter((row) => row.condition === 'base'),
  );
  const skill = conditionResult(
    byCondition.skill,
    rows.filter((row) => row.condition === 'skill'),
    measured.filter((row) => row.condition === 'skill'),
  );
  const comparison = source.comparisons.find(
    (value) => value.condition === 'skill',
  );
  assert.ok(
    comparison && comparison.excludedPairs.length === 0,
    'Missing comparable pairs',
  );
  close(
    comparison.macro.liftPercentagePoints,
    100 * (skill.macroPassRate - base.macroPassRate),
  );
  const domainResults = domains.map((id) => {
    const group = tasks.filter((task) => task.domain === id);
    return {
      id,
      baseRate: mean(group.map((task) => task.base.rate)),
      skillRate: mean(group.map((task) => task.skill.rate)),
      tasks: group,
    };
  });
  return {
    attempts: measured.length,
    taskCount: ids.length,
    conditions: { base, skill },
    comparison: {
      liftPercentagePoints: comparison.macro.liftPercentagePoints,
      regression: comparison.macro.regression,
      resamples: comparison.bootstrap.resamples,
      liftInterval95: interval(
        comparison.bootstrap.liftInterval95PercentagePoints,
      ),
      regressionInterval95: interval(comparison.bootstrap.regressionInterval95),
    },
    safety: {
      unsafe: rows.filter((row) => row.outcome.safety === 'unsafe').length,
      determinable: rows.filter((row) =>
        ['safe', 'unsafe'].includes(row.outcome.safety),
      ).length,
      unknown: rows.filter((row) => row.outcome.safety === 'unknown').length,
    },
    domains: domainResults,
    negativeControls: tasks.filter(
      (task) => task.domain === 'negative-control',
    ),
  };
}

/**
Explicit public projection: never spread private reports or execution records.
*/
export function publicEvals(
  summary: EvalsSummary,
  attempts: EvalsAttempt[],
  summarySha256: string,
) {
  assert.ok(
    !summary.comparisonEvidenceProvisional &&
      !summary.significantImprovementClaim,
    'Expected a complete exploratory comparison',
  );
  assert.ok(
    /^[a-z\d][a-z\d.-]{1,79}$/u.test(summary.model),
    'Invalid model identifier',
  );
  assert.ok(
    ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(
      summary.reasoningEffort,
    ) && summary.speed === 'standard',
    'Invalid legacy model configuration',
  );
  const batches = {
    development: batchResult(
      summary.batches.development,
      attempts,
      'development',
    ),
    sealed: batchResult(summary.batches.sealed, attempts, 'sealed'),
  };
  const count = batches.development.attempts + batches.sealed.attempts;
  assert.ok(
    summary.registeredComparisonSlots === count &&
      summary.recordedComparisonAttempts === count,
    'Registered sample count differs',
  );
  const taskIds = Object.values(batches).flatMap((batch) =>
    [
      ...batch.domains.flatMap((domain) => domain.tasks),
      ...batch.negativeControls,
    ].map((task) => task.id),
  );
  assert.ok(
    new Set(taskIds).size === taskIds.length,
    'Development and sealed tasks overlap',
  );
  return {
    schemaVersion: 1,
    measuredOn: new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Taipei',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(summary.createdAt)),
    model: summary.model,
    reasoningEffort: summary.reasoningEffort,
    speed: summary.speed,
    agent: 'Codex CLI',
    repetitions: 3,
    sourceSummarySha256: digest(summarySha256),
    productIdentity: digest(summary.productInputIdentity),
    skillDigest: digest(summary.skillDigest),
    taskCount: taskIds.length,
    negativeControlCount:
      batches.development.negativeControls.length +
      batches.sealed.negativeControls.length,
    comparisonAttempts: count,
    batches,
  };
}

/**
A complete new development cohort, kept separate from the historical report.
*/
export function publicDevelopmentRetest(
  summary: DevelopmentRetestSummary,
  attempts: EvalsAttempt[],
  summarySha256: string,
) {
  assert.ok(
    !summary.comparisonEvidenceProvisional &&
      !summary.significantImprovementClaim,
    'Expected a complete exploratory development retest',
  );
  assert.ok(
    summary.registeredComparisonSlots === 102 &&
      summary.recordedComparisonAttempts === attempts.length &&
      attempts.every((row) => row.batch === 'development'),
    'Expected the full independent development cohort',
  );
  const execution = summary.executionResolution;
  assert.ok(
    execution.initialUnknowns === execution.replacements.length &&
      execution.replacements.length <= 1 &&
      attempts.length === 102 + execution.replacements.length,
    'Invalid infrastructure replacement count',
  );
  assert.ok(
    attempts.every(
      (row) =>
        typeof row.selectedForComparison === 'boolean' &&
        /^[a-f\d]{64}-[12]$/u.test(row.runId ?? ''),
    ) && new Set(attempts.map((row) => row.runId)).size === attempts.length,
    'Missing or duplicated retest execution identity',
  );
  const selected = attempts.filter((row) => row.selectedForComparison);
  const retained = attempts.filter((row) => !row.selectedForComparison);
  assert.equal(
    selected.length,
    102,
    'Expected 102 registered comparison slots',
  );
  assert.equal(retained.length, execution.replacements.length);
  for (const replacement of execution.replacements) {
    const original = retained.find(
      (row) => row.runId === replacement.originalRunId,
    );
    const next = selected.find(
      (row) => row.runId === replacement.replacementRunId,
    );
    assert.ok(
      original && next && replacement.reason === 'native_trace_incomplete',
      'Missing infrastructure replacement evidence',
    );
    for (const row of [original, next]) {
      assert.ok(
        row.taskId === replacement.taskId &&
          row.condition === replacement.condition &&
          row.repetition === replacement.repetition,
        'Replacement changes the comparison slot',
      );
    }
    assert.ok(
      original.executionStatus === 'completed' &&
        original.executionExitCode === 0 &&
        original.captureStatus === 'complete' &&
        original.traceStatus === 'partial' &&
        original.mutationStatus === 'accepted' &&
        original.gradeStatus === 'complete' &&
        original.outcome.status === 'unknown' &&
        !original.outcome.isValidAttempt &&
        original.outcome.safety === 'safe',
      'Cannot replace a known Agent failure',
    );
  }
  assert.match(summary.model, /^[a-z\d][a-z\d.-]{1,79}$/u);
  assert.ok(
    ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(
      summary.reasoningEffort,
    ) && summary.speed === 'standard',
    'Invalid legacy model configuration',
  );
  const batch = batchResult(
    summary.development,
    selected,
    'development',
    attempts,
  );
  assert.ok(
    batch.taskCount === 17 && batch.negativeControls.length === 1,
    'Expected 17 development tasks with a separate negative control',
  );
  const grading = summary.gradingResolution;
  assert.ok(
    Number.isSafeInteger(grading.initialErrors) &&
      grading.initialErrors >= 0 &&
      grading.initialErrors <= 102 &&
      Number.isSafeInteger(grading.reassessedAttempts) &&
      grading.reassessedAttempts === grading.reassessedTasks.length * 6 &&
      grading.reassessedAttempts >= grading.initialErrors &&
      Number.isFinite(grading.additionalGradingMs) &&
      grading.additionalGradingMs >= 0 &&
      new Set(grading.reassessedTasks).size ===
        grading.reassessedTasks.length &&
      grading.reassessedTasks.every((id) =>
        [
          ...batch.domains.flatMap((d) => d.tasks),
          ...batch.negativeControls,
        ].some((t) => t.id === id),
      ),
    'Invalid uniform grading resolution',
  );
  return {
    schemaVersion: 1,
    kind: 'complete-development-retest',
    measuredOn: new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Taipei',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(summary.createdAt)),
    experimentIdentity: digest(summary.experimentIdentity),
    sourceSummarySha256: digest(summarySha256),
    parentSummarySha256: digest(summary.parentSummarySha256),
    productIdentity: digest(summary.productInputIdentity),
    skillDigest: digest(summary.skillDigest),
    model: summary.model,
    reasoningEffort: summary.reasoningEffort,
    speed: summary.speed,
    comparisonAttempts: 102,
    repetitions: 3,
    recordedAttempts: attempts.length,
    originalResultsReplaced: false,
    executionResolution: {
      identity: digest(execution.identity),
      initialUnknowns: execution.initialUnknowns,
      replacementAttempts: execution.replacements.length,
      tasks: execution.replacements.map((replacement) => replacement.taskId),
      reason:
        execution.replacements.length > 0 ? 'native_trace_incomplete' : null,
      originalRecordsRetained: true,
    },
    gradingResolution: {
      identity: digest(grading.identity),
      initialErrors: grading.initialErrors,
      reassessedTasks: grading.reassessedTasks,
      reassessedAttempts: grading.reassessedAttempts,
      additionalGradingMs: grading.additionalGradingMs,
    },
    batch,
  };
}

async function main() {
  if (process.argv[2] === '--campaign') {
    const { exportCampaign } = await import('./export-evals-campaign');
    const [directory, hash, output] = process.argv.slice(3);
    assert.ok(
      directory && hash && output,
      'Expected --campaign <private-report-directory> <source-index-sha256> <new-output-json>',
    );
    const result = await exportCampaign(directory, hash, output);
    process.stdout.write(
      JSON.stringify({
        campaignId: result.campaignId,
        models: result.models.length,
      }) + '\n',
    );
    return;
  }
  const cliArguments = process.argv.slice(2);
  const costIndex = cliArguments.indexOf('--estimated-cost');
  const costArguments =
    costIndex === -1 ? [] : cliArguments.splice(costIndex, 3);
  assert.ok(
    costArguments.length === 0 ||
      (costArguments.length === 3 && costArguments[1] && costArguments[2]),
    'Expected --estimated-cost <report-json> <sha256>',
  );
  const isDevelopmentRetest = cliArguments[0] === '--development-retest';
  const [directory, expectedHash, destination] = isDevelopmentRetest
    ? cliArguments.slice(1)
    : cliArguments;
  assert.ok(
    directory && expectedHash,
    'Usage: export-evals.ts [--development-retest] <report-directory> <expected-summary-sha256> [output-json]',
  );
  const source = path.resolve(directory, 'summary.json');
  const bytes = await readFile(source);
  const hash = createHash('sha256').update(bytes).digest('hex');
  assert.ok(hash === digest(expectedHash), 'Summary integrity differs');
  const summary = JSON.parse(bytes.toString('utf8')) as EvalsSummary &
    DevelopmentRetestSummary;
  const attempts = (
    await readFile(path.resolve(directory, 'attempts.jsonl'), 'utf8')
  )
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as EvalsAttempt);
  const result = isDevelopmentRetest
    ? publicDevelopmentRetest(summary, attempts, hash)
    : publicEvals(summary, attempts, hash);
  const costBytes = costArguments[1] ? await readFile(costArguments[1]) : null;
  if (costBytes)
    assert.equal(
      createHash('sha256').update(costBytes).digest('hex'),
      digest(costArguments[2]!),
      'Cost report integrity differs',
    );
  const publication = costBytes
    ? {
        ...result,
        estimatedCost: publicEstimatedCost(
          JSON.parse(costBytes.toString('utf8')),
          attempts,
          costArguments[2]!,
          isDevelopmentRetest ? summary.executionResolution.replacements : [],
        ),
      }
    : result;
  const formalOutput = fileURLToPath(
    new URL('../../docs/.vitepress/theme/evals-results.json', import.meta.url),
  );
  const output = destination
    ? path.resolve(destination)
    : fileURLToPath(
        new URL(
          isDevelopmentRetest
            ? '../../docs/.vitepress/theme/evals-development-retest.json'
            : '../../docs/.vitepress/theme/evals-results.json',
          import.meta.url,
        ),
      );
  assert.ok(
    output !== source && output !== path.resolve(directory, 'attempts.jsonl'),
    'Cannot overwrite experiment evidence',
  );
  if (isDevelopmentRetest) {
    assert.ok(
      output !== formalOutput &&
        output !==
          fileURLToPath(
            new URL(
              '../../docs/.vitepress/theme/evals-i03-supplement.json',
              import.meta.url,
            ),
          ),
      'Cannot replace historical evaluation snapshots',
    );
    const formal = JSON.parse(await readFile(formalOutput, 'utf8')) as {
      sourceSummarySha256: string;
      productIdentity: string;
      skillDigest: string;
    };
    assert.ok(
      summary.parentSummarySha256 === formal.sourceSummarySha256 &&
        summary.productInputIdentity === formal.productIdentity &&
        summary.skillDigest === formal.skillDigest,
      'Retest differs from the original frozen inputs',
    );
  }
  await writeFile(
    output,
    await format(JSON.stringify(publication), { parser: 'json' }),
  );
  process.stdout.write(
    `${JSON.stringify({ tasks: 'batch' in result ? result.batch.taskCount : result.taskCount, attempts: result.comparisonAttempts, sourceSha256: hash })}\n`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
