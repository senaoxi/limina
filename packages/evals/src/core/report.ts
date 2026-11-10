import type { BudgetManager, UsageRecord } from './budget.ts';
import { normalizeFinancialUsage } from './budget.ts';
import type { ConditionId, ExperimentManifest } from './experiment.ts';
import { verifyExperiment } from './experiment.ts';
import { contentIdentity } from './identity.ts';
import type { RunStore } from './run-store.ts';
import type { Domain } from './task.ts';

type RunSummary = ReturnType<RunStore['summary']>;
type SlotResult = RunSummary['slots'][number];
type BudgetSummary = ReturnType<BudgetManager['summary']>;
const validStatuses = new Set([
  'passed',
  'assertion_failed',
  'unsafe_mutation',
  'agent_error',
  'agent_timeout',
]);
const liminaDomains: Domain[] = [
  'initialization',
  'configuration',
  'reference-graph',
  'checker',
  'source-governance',
  'workflow',
  'troubleshooting',
  'package-release',
];

function mean(values: number[]): number | null {
  return values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
}
function interval(passes: number, count: number): [number, number] | null {
  if (!count) return null;
  const z2 = 1.959963984540054 ** 2;
  const proportion = passes / count;
  const center = (proportion + z2 / (2 * count)) / (1 + z2 / count);
  const radius =
    (Math.sqrt((proportion * (1 - proportion) + z2 / (4 * count)) / count) *
      Math.sqrt(z2)) /
    (1 + z2 / count);
  return [Math.max(0, center - radius), Math.min(1, center + radius)];
}
function rate(slots: SlotResult[]) {
  const valid = slots.filter((slot) => validStatuses.has(slot.status));
  const passed = valid.filter((slot) => slot.status === 'passed').length;
  const counts: Record<string, number> = {};
  for (const slot of slots)
    counts[slot.status] = (counts[slot.status] ?? 0) + 1;
  return {
    planned: slots.length,
    valid: valid.length,
    passed,
    rate: valid.length > 0 ? passed / valid.length : null,
    interval95: interval(passed, valid.length),
    statuses: counts,
  };
}
function safety(slots: SlotResult[]) {
  let unsafe = 0;
  let safe = 0;
  let unknown = 0;
  let notRun = 0;
  for (const slot of slots) {
    if (!slot.selected) {
      notRun++;
      continue;
    }
    const value =
      slot.evidenceStatus === 'complete'
        ? slot.selected.outcome.safety
        : 'unknown';
    if (value === 'unsafe') unsafe++;
    else if (value === 'safe') safe++;
    else unknown++;
  }
  return {
    observedUnsafe: unsafe,
    determinable: safe + unsafe,
    unknown,
    notRun,
    rate: safe + unsafe ? unsafe / (safe + unsafe) : null,
  };
}
function activation(slots: SlotResult[]) {
  return Object.fromEntries(
    (['installed', 'discovered', 'used'] as const).map((key) => {
      const counts = { yes: 0, no: 0, unknown: 0, notRun: 0 };
      for (const slot of slots) {
        if (slot.selected) {
          counts[
            slot.evidenceStatus === 'complete'
              ? slot.selected.activation[key]
              : 'unknown'
          ]++;
        } else {
          counts.notRun++;
        }
      }
      return [key, counts];
    }),
  );
}
function measurements(values: (number | null)[], coverage?: boolean[]) {
  const observed = values.filter((value): value is number => value !== null);
  const incompleteCount = coverage
    ? values.filter((value, index) => value !== null && !coverage[index]).length
    : 0;
  return {
    observedSum: observed.reduce((sum, value) => sum + value, 0),
    observedCount: observed.length,
    missingCount: values.length - observed.length,
    ...(coverage && { incompleteCount }),
    total:
      incompleteCount === 0 && observed.length === values.length
        ? observed.reduce((sum, value) => sum + value, 0)
        : null,
  };
}

export function summarizeUsage(usages: (UsageRecord | null)[]) {
  const financial = usages.map((usage) =>
    usage ? normalizeFinancialUsage(usage) : null,
  );
  const coverage = usages.map((usage) => usage?.complete ?? false);
  return {
    records: usages.length,
    completeRecords: usages.filter((usage) => usage?.complete).length,
    inputTokens: measurements(
      usages.map((usage) => usage?.inputTokens ?? null),
      coverage,
    ),
    cachedInputTokens: measurements(
      usages.map((usage) => usage?.cachedInputTokens ?? null),
      coverage,
    ),
    outputTokens: measurements(
      usages.map((usage) => usage?.outputTokens ?? null),
      coverage,
    ),
    credits: measurements(usages.map((usage) => usage?.credits ?? null)),
    estimatedUsd: measurements(
      usages.map((usage) => usage?.estimatedUsd ?? null),
    ),
    settledUsd: measurements(
      financial.map((usage) => usage?.settledUsd ?? null),
    ),
    settlement: Object.fromEntries(
      ['included', 'pending', 'settled', 'unknown'].map((state) => [
        state,
        financial.filter((usage) => (usage?.settlement ?? 'unknown') === state)
          .length,
      ]),
    ),
  };
}

interface Pair {
  taskId: string;
  domain: Domain;
  base: number;
  treatment: number;
}
function pairMetric(pairs: Pair[]) {
  return {
    count: pairs.length,
    baseRate: mean(pairs.map((pair) => pair.base)),
    treatmentRate: mean(pairs.map((pair) => pair.treatment)),
    liftPercentagePoints:
      pairs.length > 0
        ? 100 * mean(pairs.map((pair) => pair.treatment - pair.base))!
        : null,
    // Joint probability over paired attempts, not conditional on Base success.
    regression: mean(
      pairs.map((pair) => (pair.base === 1 && pair.treatment === 0 ? 1 : 0)),
    ),
  };
}
function macro(pairs: Pair[]) {
  const domains = liminaDomains.map((domain) => {
    const group = pairs.filter((pair) => pair.domain === domain);
    const tasks = [...new Set(group.map((pair) => pair.taskId))];
    if (tasks.length === 0) return null;
    const values = tasks.map((taskId) =>
      pairMetric(group.filter((pair) => pair.taskId === taskId)),
    );
    return {
      lift: mean(values.map((value) => value.liftPercentagePoints!))!,
      regression: mean(values.map((value) => value.regression!))!,
    };
  });
  if (domains.includes(null)) return null;
  return {
    liftPercentagePoints: mean(domains.map((domain) => domain!.lift))!,
    regression: mean(domains.map((domain) => domain!.regression))!,
  };
}
function random(seed: string) {
  let state = Number.parseInt(contentIdentity(seed).slice(0, 8), 16) || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4_294_967_296;
  };
}
function percentile(values: number[], probability: number) {
  const index = (values.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  return values[lower]! + (values[upper]! - values[lower]!) * (index - lower);
}
function bootstrap(pairs: Pair[], seed: string) {
  if (!macro(pairs)) return null;
  const rng = random(seed);
  const groups = liminaDomains.map((domain) => {
    const group = pairs.filter((pair) => pair.domain === domain);
    return [...new Set(group.map((pair) => pair.taskId))].map((id) =>
      group.filter((pair) => pair.taskId === id),
    );
  });
  const lifts: number[] = [];
  const regressions: number[] = [];
  for (let iteration = 0; iteration < 10_000; iteration++) {
    const domainLifts: number[] = [];
    const domainRegressions: number[] = [];
    for (const tasks of groups) {
      const taskMetrics = tasks.map(() => {
        const task = tasks[Math.floor(rng() * tasks.length)]!;
        const selected = Array.from(
          { length: task.length },
          () => task[Math.floor(rng() * task.length)]!,
        );
        return pairMetric(selected);
      });
      domainLifts.push(
        mean(taskMetrics.map((value) => value.liftPercentagePoints!))!,
      );
      domainRegressions.push(
        mean(taskMetrics.map((value) => value.regression!))!,
      );
    }
    lifts.push(mean(domainLifts)!);
    regressions.push(mean(domainRegressions)!);
  }
  lifts.sort((a, b) => a - b);
  regressions.sort((a, b) => a - b);
  return {
    method:
      'hierarchical paired task/block bootstrap; domains equally weighted',
    seed,
    resamples: 10_000,
    liftInterval95PercentagePoints: [
      percentile(lifts, 0.025),
      percentile(lifts, 0.975),
    ],
    regressionInterval95: [
      percentile(regressions, 0.025),
      percentile(regressions, 0.975),
    ],
  };
}

function comparison(
  manifest: ExperimentManifest,
  slots: SlotResult[],
  condition: ConditionId,
) {
  const pairs: Pair[] = [];
  const exclusions: { taskId: string; repetition: number; reason: string }[] =
    [];
  for (const treatment of slots) {
    if (treatment.slot.condition !== condition) continue;
    const base = slots.find(
      (slot) =>
        slot.slot.condition === 'base' &&
        slot.slot.block === treatment.slot.block,
    );
    const reason = base
      ? base.slot.comparisonIdentity === treatment.slot.comparisonIdentity
        ? !validStatuses.has(base.status) ||
          !validStatuses.has(treatment.status)
          ? 'unresolved_or_invalid_attempt'
          : null
        : 'different_comparison_identity'
      : 'missing_base_slot';
    if (reason) {
      exclusions.push({
        taskId: treatment.slot.taskId,
        repetition: treatment.slot.repetition,
        reason,
      });
      continue;
    }
    const task = manifest.inputs.tasks.find(
      (task) => task.id === treatment.slot.taskId,
    )!;
    pairs.push({
      taskId: task.id,
      domain: task.domain,
      base: base!.status === 'passed' ? 1 : 0,
      treatment: treatment.status === 'passed' ? 1 : 0,
    });
  }
  const perTask = manifest.inputs.tasks
    .filter((task) => slots.some((slot) => slot.slot.taskId === task.id))
    .map((task) => ({
      taskId: task.id,
      domain: task.domain,
      ...pairMetric(pairs.filter((pair) => pair.taskId === task.id)),
    }));
  const isCompleteState = slots
    .filter(
      (slot) =>
        slot.slot.condition === 'base' || slot.slot.condition === condition,
    )
    .every(
      (slot) =>
        slot.selected &&
        slot.evidenceStatus === 'complete' &&
        slot.selected.facts.captureStatus === 'complete' &&
        slot.selected.facts.traceStatus === 'complete',
    );
  return {
    condition,
    exploratory: true,
    significantImprovementClaim: false,
    inferenceLimit:
      'Preregistered three repetitions are fewer than five complete pairs per task; no significant-improvement conclusion is authorized.',
    provisional: exclusions.length > 0 || !isCompleteState,
    perTask,
    macro: macro(pairs),
    bootstrap: bootstrap(
      pairs,
      `${manifest.inputs.seed}:${condition}:report-v1`,
    ),
    negativeControl: pairs.some((pair) => pair.domain === 'negative-control')
      ? pairMetric(pairs.filter((pair) => pair.domain === 'negative-control'))
      : null,
    excludedPairs: exclusions,
  };
}

function conditionSummaries(
  manifest: ExperimentManifest,
  results: SlotResult[],
  summary: RunSummary,
) {
  return manifest.inputs.conditions.map(({ id }) => {
    const slots = results.filter((slot) => slot.slot.condition === id);
    const attempts = summary.attempts.filter((attempt) =>
      slots.some((slot) => slot.slot.id === attempt.slot.id),
    );
    const attemptSlots: SlotResult[] = attempts.map((selected) => ({
      slot: selected.slot,
      selected,
      status: selected.outcome.status,
      evidenceStatus:
        summary.attemptEvidence.find(
          (evidence) => evidence.runId === selected.runId,
        )?.status ?? 'unknown',
    }));
    const tasks = manifest.inputs.tasks
      .filter((task) =>
        results.some((result) => result.slot.taskId === task.id),
      )
      .map((task) => ({
        taskId: task.id,
        domain: task.domain,
        split: task.split,
        ...rate(slots.filter((slot) => slot.slot.taskId === task.id)),
      }));
    const domains = liminaDomains.map((domain) => {
      const values = tasks.filter((task) => task.domain === domain);
      return {
        domain,
        taskCount: values.length,
        rate:
          values.length > 0 && values.every((task) => task.rate !== null)
            ? mean(values.map((task) => task.rate!))
            : null,
      };
    });
    return {
      id,
      tasks,
      domains,
      macroPassRate: domains.every((domain) => domain.rate !== null)
        ? mean(domains.map((domain) => domain.rate!))
        : null,
      negativeControl: tasks.filter(
        (task) => task.domain === 'negative-control',
      ),
      unsafeMutation: safety(slots),
      allAttemptUnsafeMutation: safety(attemptSlots),
      activation: activation(slots),
      usage: summarizeUsage(attempts.map((attempt) => attempt.usage)),
      time: {
        agentMs: measurements(attempts.map((attempt) => attempt.time.agentMs)),
        endToEndMs: measurements(
          attempts.map((attempt) => attempt.time.endToEndMs),
        ),
      },
    };
  });
}

function assertBudgetReservation(
  record: RunSummary['attempts'][number],
  entry: BudgetSummary['attempts'][number] | undefined,
  manifest: ExperimentManifest,
): asserts entry is BudgetSummary['attempts'][number] {
  if (
    !entry ||
    entry.reservation.taskId !== record.slot.taskId ||
    (manifest.version === 2 &&
      (entry.reservation.modelProfile?.id !==
        manifest.inputs.modelProfile?.id ||
        entry.reservation.experimentIdentity !== manifest.identity ||
        entry.reservation.slotId !== record.slot.id ||
        entry.reservation.campaignId !== manifest.inputs.campaignId ||
        entry.reservation.model !== manifest.policy.model))
  )
    throw new Error('Run attempt is absent from the shared budget ledger');
}

/**
Allowlisted derived data only: no prompts, hidden assertions, file contents or raw traces.
*/
export function buildReport(
  manifest: ExperimentManifest,
  summary: RunSummary,
  budget: BudgetSummary,
) {
  verifyExperiment(manifest);
  if (
    summary.experimentIdentity !== manifest.identity ||
    summary.slots.length !== manifest.slots.length ||
    manifest.slots.some(
      (slot) =>
        summary.slots.filter(
          (value) => contentIdentity(value.slot) === contentIdentity(slot),
        ).length !== 1,
    )
  )
    throw new Error(
      'Report input does not match the complete frozen experiment',
    );
  const budgetByRun = new Map(
    budget.attempts.map((attempt) => [attempt.reservation.runId, attempt]),
  );
  const accountedAttempts = summary.attempts.map((record) => {
    const entry = budgetByRun.get(record.runId);
    if (
      !entry &&
      record.usage === null &&
      record.facts.execution.status === 'infra_error' &&
      record.facts.execution.evidence.phase === 'setup'
    )
      return record;
    assertBudgetReservation(record, entry, manifest);
    for (const key of [
      'inputTokens',
      'cachedInputTokens',
      'outputTokens',
    ] as const)
      if (
        record.usage?.[key] !== null &&
        record.usage?.[key] !== undefined &&
        record.usage[key] !== entry.usage?.[key]
      )
        throw new Error(
          'Attempt usage disagrees with the shared budget ledger',
        );
    return { ...record, usage: entry.usage };
  });
  const accountedSummary = { ...summary, attempts: accountedAttempts };
  const conditions = conditionSummaries(
    manifest,
    summary.slots,
    accountedSummary,
  );
  const attempts = accountedAttempts;
  const budgetAttempts = budget.attempts.filter(
    (attempt) => !attempt.notDispatchedEvidence,
  );
  const financial = summarizeUsage(
    budgetAttempts.map((attempt) => attempt.usage),
  );
  const actualTotal = financial.settledUsd.total;
  return {
    version: manifest.version,
    ...(manifest.version === 2 && {
      modelProfile: manifest.inputs.modelProfile!,
      bank: manifest.inputs.bank!,
      campaignId: manifest.inputs.campaignId!,
    }),
    experimentIdentity: manifest.identity,
    batch: manifest.inputs.kind,
    exploratory: true,
    financialProvisional: actualTotal === null,
    provisional: summary.slots.some(
      (slot) =>
        !validStatuses.has(slot.status) ||
        slot.evidenceStatus !== 'complete' ||
        slot.selected?.facts.captureStatus !== 'complete' ||
        slot.selected.facts.traceStatus !== 'complete',
    ),
    plannedSlots: summary.slots.length,
    recordedAttempts: attempts.length,
    conditions,
    bySplit: (['dev', 'sealed'] as const)
      .map((split) => {
        const ids = new Set(
          manifest.inputs.tasks
            .filter((task) => task.split === split)
            .map((task) => task.id),
        );
        const slots = summary.slots.filter((slot) => ids.has(slot.slot.taskId));
        return {
          split,
          plannedSlots: slots.length,
          conditions: conditionSummaries(manifest, slots, accountedSummary),
          comparisons: manifest.inputs.conditions
            .filter(
              (condition) =>
                condition.id === 'skill' || condition.id === 'candidate',
            )
            .map((condition) => comparison(manifest, slots, condition.id)),
        };
      })
      .filter((group) => group.plannedSlots > 0),
    comparisons: manifest.inputs.conditions
      .filter(
        (condition) => condition.id === 'skill' || condition.id === 'candidate',
      )
      .map((condition) => comparison(manifest, summary.slots, condition.id)),
    usage: summarizeUsage(attempts.map((attempt) => attempt.usage)),
    time: {
      agentMs: measurements(attempts.map((attempt) => attempt.time.agentMs)),
      endToEndMs: measurements(
        attempts.map((attempt) => attempt.time.endToEndMs),
      ),
    },
    budget: {
      currency: budget.currency,
      totalLimit: budget.totalLimit,
      reserve: budget.reserve,
      committedSpend: budget.committedSpend,
      settledSpend: actualTotal,
      observedSettledSpend: financial.settledUsd.observedSum,
      financialUnknownRecords: financial.settledUsd.missingCount,
      maximumExposure: budget.maximumExposure,
      remainingAuthorization: budget.remainingAuthorization,
      includedPolicyRecords: budgetAttempts.filter(
        (attempt) => attempt.reservation.billing.mode === 'included_only',
      ).length,
      accountingVersion: 2,
      estimatedSpend: budget.estimatedSpend,
      remainingBudget:
        actualTotal === null
          ? null
          : Math.max(
              0,
              budget.totalLimit - actualTotal - budget.committedSpend,
            ),
      allDiagnosticsAndAttempts: financial,
      provedNonDispatchCount: budget.attempts.length - budgetAttempts.length,
      billingModes: [
        ...new Set(
          budgetAttempts.map((attempt) => attempt.reservation.billing.mode),
        ),
      ],
      rateCardVersions: [
        ...new Set(
          budgetAttempts.map(
            (attempt) => attempt.reservation.billing.rateCardVersion,
          ),
        ),
      ],
    },
  };
}
