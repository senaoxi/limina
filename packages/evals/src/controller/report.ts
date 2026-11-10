import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ExperimentManifest } from '../core/experiment.ts';
import { buildReport } from '../core/report.ts';
import { RunStore } from '../core/run-store.ts';
import { sha256 } from '../core/snapshot.ts';
import {
  collectEstimatedCosts,
  type EstimatedCostReport,
} from './estimated-cost.ts';
import { verifyBudgetSource } from './run-budget.ts';

function percentage(value: number | null): string {
  return value === null ? 'unknown' : `${(value * 100).toFixed(2)}%`;
}
function markdown(
  report: ReturnType<typeof buildReport> & {
    estimatedCost: EstimatedCostReport;
  },
): string {
  const lines = [
    '# Limina Skill evaluation report',
    '',
    `Experiment: \`${report.experimentIdentity}\`. Batch: ${report.batch}.`,
    '',
    `${report.provisional ? 'Provisional: missing or incomplete execution/grading evidence remains.' : 'All planned slots have complete execution/grading evidence.'} Results are exploratory; three repetitions do not authorize a significant-improvement claim. Monetary evidence is assessed separately below.`,
    '',
    `Planned slots: ${report.plannedSlots}; recorded attempts including replacements: ${report.recordedAttempts}.`,
    '',
  ];
  for (const group of report.bySplit) {
    lines.push(
      `## ${group.split === 'dev' ? 'Development' : 'Sealed acceptance'}`,
      '',
      '| Condition | Task | Passed / valid | Pass rate | Status counts |',
      '| --- | --- | --- | --- | --- |',
    );
    for (const condition of group.conditions)
      for (const task of condition.tasks)
        lines.push(
          `| ${condition.id} | ${task.taskId} | ${task.passed} / ${task.valid} | ${percentage(task.rate)} | ${Object.entries(
            task.statuses,
          )
            .map(([status, count]) => `${status}: ${count}`)
            .join(', ')} |`,
        );
    lines.push(
      '',
      'Negative controls remain separate from the eight-domain macro rate.',
      '',
      '| Condition | Macro pass rate | Unsafe / determinable | Safety unknown |',
      '| --- | --- | --- | --- |',
    );
    for (const condition of group.conditions)
      lines.push(
        `| ${condition.id} | ${percentage(condition.macroPassRate)} | ${condition.unsafeMutation.observedUnsafe} / ${condition.unsafeMutation.determinable} | ${condition.unsafeMutation.unknown} |`,
      );
    lines.push('');
    for (const comparison of group.comparisons)
      lines.push(
        `${comparison.condition} vs Base: ${comparison.macro ? `${comparison.macro.liftPercentagePoints.toFixed(2)} percentage points; regression ${percentage(comparison.macro.regression)}` : 'macro comparison unknown'}. Excluded pairs: ${comparison.excludedPairs.length}. ${comparison.provisional ? 'Provisional.' : 'Complete paired outcomes.'}`,
        '',
      );
  }
  lines.push(
    '## Usage and budget',
    '',
    'Cached input is a subset of input tokens and is not added again. Unknown totals stay null in report.json; observed sums do not imply completeness. Per-task intervals, fixed-seed 10,000-resample bootstrap intervals, activation evidence and Agent/end-to-end durations are included in report.json.',
    '',
    '| Measurement | Observed sum | Missing records | Partial coverage | Complete total |',
    '| --- | --- | --- | --- | --- |',
  );
  for (const key of [
    'inputTokens',
    'cachedInputTokens',
    'outputTokens',
    'credits',
    'estimatedUsd',
    'settledUsd',
  ] as const) {
    const measurement = report.usage[key];
    lines.push(
      `| ${key} | ${measurement.observedCount ? measurement.observedSum : 'unknown'} | ${measurement.missingCount} | ${measurement.incompleteCount ?? 0} | ${measurement.total ?? 'unknown'} |`,
    );
  }
  lines.push(
    '',
    `Estimated API-equivalent cost: observed USD ${report.estimatedCost.summary.observedUsd.toFixed(6)}; complete total: ${report.estimatedCost.summary.totalUsd ?? 'unknown'}; complete attempts: ${report.estimatedCost.summary.completeAttempts}/${report.estimatedCost.summary.attempts}. Pricing: ${report.estimatedCost.pricing.version}. This is a public-API price estimate, not subscription charges, credits deducted or monetary settlement; it does not change dispatch authorization.`,
    '',
    `Global extra-paid authorization ceiling: USD ${report.budget.totalLimit}; reserve: ${report.budget.reserve}. Actual settlement total: ${report.budget.settledSpend ?? 'unknown'}; records without monetary settlement evidence: ${report.budget.financialUnknownRecords}. Actual remaining budget: ${report.budget.remainingBudget ?? 'unknown'}.`,
    '',
    `Conditional maximum exposure under the admitted dispatch policy: USD ${report.budget.maximumExposure}; remaining authorization: ${report.budget.remainingAuthorization}. These are policy bounds, not observed bills. Included-only eligibility does not establish a zero-dollar settlement.`,
    '',
    `Global ledger covers ${report.budget.allDiagnosticsAndAttempts.records} dispatched attempts and diagnostics, including failures. Included-only policy records: ${report.budget.includedPolicyRecords}. Pending/unknown monetary settlement records: ${(report.budget.allDiagnosticsAndAttempts.settlement.pending ?? 0) + (report.budget.allDiagnosticsAndAttempts.settlement.unknown ?? 0)}. No subscription-to-task or API-price conversion is applied.`,
    '',
    'This report exports aggregates and task IDs only. Raw prompts, hidden assertions, credentials and execution payloads are not included.',
    '',
  );
  return lines.join('\n');
}

export async function writeReport(
  runDirectory: string,
  budgetLedger: string,
  output: string,
) {
  for (const input of [runDirectory, budgetLedger])
    if (!path.isAbsolute(input) || (await realpath(input)) !== input)
      throw new Error('Report inputs must be canonical controller paths');
  const ledger = await stat(budgetLedger);
  if (!ledger.isFile()) throw new Error('Global budget ledger is required');
  if (
    !path.isAbsolute(output) ||
    path.resolve(output) !== output ||
    (await realpath(path.dirname(output))) !== path.dirname(output)
  )
    throw new Error('Report output must be a new canonical directory');
  const manifest = JSON.parse(
    await readFile(path.join(runDirectory, 'manifest.json'), 'utf8'),
  ) as ExperimentManifest;
  const store = RunStore.open(runDirectory);
  const billing = await verifyBudgetSource(store, budgetLedger);
  const metrics = buildReport(manifest, store.summary(), billing.budget);
  const estimatedCost = await collectEstimatedCosts([runDirectory]);
  if (estimatedCost.attempts.length !== metrics.recordedAttempts)
    throw new Error('Cost cohort changed during report generation');
  const report = {
    ...metrics,
    estimatedCost,
    reportingSource: {
      calculation: sha256(
        await readFile(new URL('../core/report.ts', import.meta.url)),
      ),
      export: sha256(await readFile(new URL('report.ts', import.meta.url))),
      financialInterpretation: sha256(
        await readFile(new URL('../core/budget.ts', import.meta.url)),
      ),
      ledger: billing.digest,
      estimatedCost: estimatedCost.identity,
    },
  };
  await mkdir(output, { mode: 0o700 });
  await writeFile(
    path.join(output, 'report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    { flag: 'wx', mode: 0o600 },
  );
  await writeFile(path.join(output, 'report.md'), markdown(report), {
    flag: 'wx',
    mode: 0o600,
  });
  return report;
}
