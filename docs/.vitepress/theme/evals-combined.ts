import type { PublicBankCalibration } from './evals-calibration-types';
import type {
  PublicCampaign,
  PublishedAverage,
  PublishedMeasurements,
} from './evals-campaign-types';
import type {
  CampaignEntry,
  CurrentSelection,
  CurrentSummaries,
  PublishedCohort,
  PublishedModelRow,
} from './evals-cohorts';
import {
  bindCurrentSummary,
  currentSummaries,
  latestCampaignEntries,
} from './evals-cohorts';
import type { PublicCurrentSummary } from './evals-summary-types';

type Bank = Pick<PublicBankCalibration, 'bankId' | 'bankRevision'> & {
  tasks: readonly Pick<
    PublicBankCalibration['tasks'][number],
    'id' | 'domain' | 'split' | 'role'
  >[];
};
type Report = NonNullable<PublicCampaign['models'][number]['report']>;
type Task = Report['tasks'][number];
type Condition = Task['conditions'][string];
type Counts = NonNullable<Report['counts']>[string];
type AttemptSummary = Counts & {
  unknown: number;
  rate: number | null;
  coverage: number;
};
const stages: readonly string[] = ['development', 'sealed'];
const conditions = ['base', 'skill'] as const;
type Stage = 'development' | 'sealed';

export type CombinedTask = Task & {
  stage: Stage;
  source: Pick<
    CampaignEntry,
    'file' | 'campaignId' | 'bankId' | 'reportIdentity'
  >;
  selectedCondition?: PublicCurrentSummary['sources']['task'];
};

interface CombinedResults {
  tasks: CombinedTask[];
  counts: Record<string, Counts>;
  attempts: Record<string, AttemptSummary>;
  macro: Record<string, number | null>;
  differencePercentagePoints: number | null;
  macroDifferencePercentagePoints: number | null;
  measurements: PublishedMeasurements;
}

export interface CombinedModelRow {
  key: string;
  profile: PublishedModelRow['profile'];
  sources: PublishedModelRow[];
  main: CombinedResults;
  negativeControls: CombinedResults;
}

// The current summary explicitly selects one historical campaign family. Only
// its companion stage, on that exact source Bank, can join the current view.
export function combinedCampaignEntries(
  entries: readonly CampaignEntry[],
  bank: Pick<Bank, 'bankId' | 'bankRevision'>,
  summary?: CurrentSummaries,
): CampaignEntry[] {
  const selected = latestCampaignEntries(entries, bank, summary).filter(
    (entry) => stages.includes(entry.stage),
  );
  for (const selectedSummary of currentSummaries(summary)) {
    for (const stage of stages) {
      const companion = entries.findLast(
        (entry) =>
          entry.campaignId === selectedSummary.sources.base.campaignId &&
          entry.stage === stage,
      );
      if (!companion) continue;
      if (
        companion.bankId !== selectedSummary.sources.base.bankId ||
        companion.bankRevision !== selectedSummary.bankRevision
      )
        throw new Error('Combined summary companion Bank identity differs');
      if (!selected.includes(companion)) selected.push(companion);
    }
  }
  return selected;
}

function executions(cell: Condition): number {
  return (
    cell.executions ??
    cell.repetitions.reduce((sum, run) => sum + run.attemptCount, 0)
  );
}

function checkMeasurement(value: PublishedAverage, count: number): void {
  if (
    value.executions !== count ||
    value.cells !== 1 ||
    !Number.isSafeInteger(value.measured) ||
    value.measured < 0 ||
    value.measured > count ||
    value.measuredCells !== (value.mean === null ? 0 : 1) ||
    (value.mean === null) !== (value.measured === 0) ||
    !Number.isFinite(value.coverage) ||
    Math.abs(value.coverage - (count ? value.measured / count : 0)) > 1e-10
  )
    throw new Error('Combined measurement execution coverage differs');
}

function measurements(cells: readonly Condition[]): PublishedMeasurements {
  const average = (key: keyof PublishedMeasurements): PublishedAverage => {
    let meanSum = 0;
    let observedSum = 0;
    let measured = 0;
    let count = 0;
    let measuredCells = 0;
    for (const cell of cells) {
      const n = executions(cell);
      const value = cell.measurements?.[key];
      count += n;
      if (!value) continue;
      checkMeasurement(value, n);
      observedSum += value.observedSum;
      measured += value.measured;
      if (value.mean === null) {
        continue;
      }

      meanSum += value.mean;
      measuredCells++;
    }
    return {
      mean: measuredCells ? meanSum / measuredCells : null,
      observedSum,
      total: measured === count && count > 0 ? observedSum : null,
      measured,
      executions: count,
      coverage: count ? measured / count : 0,
      cells: cells.length,
      measuredCells,
    };
  };
  return {
    inputTokens: average('inputTokens'),
    agentMs: average('agentMs'),
    endToEndMs: average('endToEndMs'),
    apiEquivalentUsd: average('apiEquivalentUsd'),
    settledUsd: average('settledUsd'),
  };
}

function summarize(tasks: CombinedTask[]): CombinedResults {
  const domains = [...new Set(tasks.map((task) => task.domain))];
  const counts: Record<string, Counts> = {};
  const attempts: Record<string, AttemptSummary> = {};
  const macro: Record<string, number | null> = {};
  for (const condition of conditions) {
    const cells = tasks.map((task) => task.conditions[condition]!);
    counts[condition] = cells.reduce(
      (sum, cell) => ({
        passed: sum.passed + cell.passed,
        valid: sum.valid + cell.valid,
        planned: sum.planned + cell.planned,
        executions: sum.executions + executions(cell),
      }),
      { passed: 0, valid: 0, planned: 0, executions: 0 },
    );
    const total = counts[condition]!;
    attempts[condition] = {
      ...total,
      // Verified passes and determinable results retain their source authority.
      // Physical executions also include unresolved infrastructure replacements.
      unknown: total.executions - total.valid,
      rate: total.executions > 0 ? total.passed / total.executions : null,
      coverage: total.executions > 0 ? total.valid / total.executions : 0,
    };
    const rates = domains.map((domain) => {
      const members = tasks.filter((task) => task.domain === domain);
      if (members.some((task) => task.conditions[condition]!.valid === 0))
        return null;
      return (
        members.reduce((sum, task) => {
          const cell = task.conditions[condition]!;
          return sum + cell.passed / cell.valid;
        }, 0) / members.length
      );
    });
    macro[condition] =
      rates.length > 0 && rates.every((rate) => rate !== null)
        ? rates.reduce((sum, rate) => sum + rate, 0) / rates.length
        : null;
  }
  return {
    tasks,
    counts,
    attempts,
    macro,
    // A descriptive difference. Existing task pairs, including a withheld
    // cross-source P03 pair, remain untouched in the original stage sources.
    differencePercentagePoints:
      attempts.base!.rate !== null && attempts.skill!.rate !== null
        ? 100 * (attempts.skill!.rate - attempts.base!.rate)
        : null,
    macroDifferencePercentagePoints:
      macro.base !== null && macro.skill !== null
        ? 100 * (macro.skill! - macro.base!)
        : null,
    measurements: measurements(
      tasks.flatMap((task) => conditions.map((id) => task.conditions[id]!)),
    ),
  };
}

function checkSources(
  sources: readonly PublishedModelRow[],
  bank: Bank,
  summaries: readonly PublicCurrentSummary[],
): void {
  const first = sources[0]!;
  if (
    new Set(sources.map((row) => row.source.stage)).size !== sources.length ||
    sources.some(
      (row) =>
        row.source.bankId !== first.source.bankId ||
        row.source.bankRevision !== bank.bankRevision ||
        row.profile.model !== first.profile.model ||
        row.profile.reasoningEffort !== first.profile.reasoningEffort ||
        row.profile.serviceTier !== first.profile.serviceTier ||
        row.profile.codexVersion !== first.profile.codexVersion,
    )
  )
    throw new Error('Combined model source identity differs');
  if (
    first.source.bankId !== bank.bankId &&
    summaries.every(
      (summary) =>
        first.source.bankId !== summary.sources.base.bankId ||
        first.source.campaignId !== summary.sources.base.campaignId ||
        first.profile.id !== summary.modelProfileId,
    )
  )
    throw new Error('Combined model source identity differs');
}

export function combinedModelRows(
  cohorts: readonly PublishedCohort[],
  bank: Bank,
  selection?: CurrentSelection | readonly CurrentSelection[],
): CombinedModelRow[] {
  const selections = selection
    ? 'summary' in selection
      ? [selection]
      : selection
    : [];
  const rows: PublishedModelRow[] = cohorts
    .filter(({ data }) => stages.includes(data.stage))
    .flatMap(({ data, file }) =>
      data.models
        .filter(
          (model) =>
            model.status === 'recorded' &&
            model.report &&
            model.report.executions >= model.report.planned &&
            model.report.tasks.every((task) =>
              conditions.every((id) => {
                const cell = task.conditions[id];
                return (
                  cell &&
                  cell.repetitions.length === cell.planned &&
                  cell.repetitions.every((run) => run.attemptCount > 0)
                );
              }),
            ),
        )
        .map((model) => ({
          ...model,
          key: `${data.campaignId}:${model.profile.id}`,
          source: data,
          file,
        })),
    );
  const bound = selections.reduce(
    (selectedRows, item) =>
      bindCurrentSummary(selectedRows, item.summary, item.task),
    rows,
  );
  const groups = new Map<string, PublishedModelRow[]>();
  for (const row of bound) {
    const key = `${row.source.campaignId}:${row.profile.id}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return Array.from(groups, ([key, sources]) => {
    const first = sources[0]!;
    checkSources(
      sources,
      bank,
      selections.map((item) => item.summary),
    );
    const tasks: CombinedTask[] = [];
    for (const row of sources) {
      const stage = row.source.stage as Stage;
      const expected = bank.tasks.filter((task) =>
        stage === 'development'
          ? task.split === 'dev'
          : task.split === 'sealed',
      );
      if (
        row.report!.tasks.length !== expected.length ||
        row.report!.tasks.some((task) => {
          const spec = expected.find((spec) => spec.id === task.id);
          return (
            !spec || spec.domain !== task.domain || spec.role !== task.role
          );
        }) ||
        new Set(row.report!.tasks.map((task) => task.id)).size !==
          expected.length
      )
        throw new Error('Combined task inventory or original split differs');
      for (const task of row.report!.tasks) {
        for (const id of conditions) {
          const cell = task.conditions[id];
          if (
            !cell ||
            [cell.passed, cell.valid, cell.planned, executions(cell)].some(
              (n) => !Number.isSafeInteger(n) || n < 0,
            ) ||
            cell.passed > cell.valid ||
            cell.valid > cell.planned ||
            executions(cell) < cell.planned ||
            cell.repetitions.length !== cell.planned ||
            new Set(cell.repetitions.map((run) => run.repetition)).size !==
              cell.planned
          )
            throw new Error('Combined independent-attempt counts differ');
        }
        tasks.push({
          ...task,
          stage,
          source: {
            file: row.file,
            campaignId: row.source.campaignId,
            bankId: row.source.bankId,
            reportIdentity: row.source.reportIdentity,
          },
          ...(task.id === row.summary?.sources.task.taskId && {
            selectedCondition: row.summary.sources.task,
          }),
        });
      }
    }
    // Both inventories must have executed. A grader_error can still leave a
    // fully executed bank unresolved: counts retain valid/planned coverage and
    // the original source's report.complete is never rewritten.
    if (
      stages.some((stage) => sources.every((row) => row.source.stage !== stage))
    )
      return [];
    tasks.sort((a, b) => a.id.localeCompare(b.id));
    return [
      {
        key,
        profile: first.profile,
        sources,
        main: summarize(tasks.filter((task) => task.role === 'main')),
        negativeControls: summarize(
          tasks.filter((task) => task.role === 'negative-control'),
        ),
      },
    ];
  }).flat();
}
