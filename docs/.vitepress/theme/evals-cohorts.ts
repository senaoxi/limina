import type { PublicCampaign } from './evals-campaign-types';
import type { PublicCurrentSummary } from './evals-summary-types';
import type { PublicTaskResult } from './evals-task-result-types';

export interface CampaignEntry {
  file: string;
  bankId?: string;
  bankRevision: string;
  stage: string;
  campaignId: string;
  reportIdentity: string;
}

export interface PublishedCohort {
  file: string;
  data: PublicCampaign;
}

const formalStages = new Set(['development', 'sealed', 'confirmation']);
const isCompleteModel = (model: PublicCampaign['models'][number]) =>
  model.status === 'recorded' && model.report?.complete === true;

export function completePublishedCohorts(
  cohorts: readonly PublishedCohort[],
): PublishedCohort[] {
  return cohorts.filter(
    ({ data }) =>
      formalStages.has(data.stage) &&
      data.models.some((model) => isCompleteModel(model)),
  );
}

export type PublishedModelRow = PublicCampaign['models'][number] & {
  key: string;
  source: PublicCampaign;
  file: string;
  summary?: PublicCurrentSummary;
};

// A newer report supersedes only the same campaign/stage in the view. Historical
// snapshots remain immutable, and different campaigns never share model rows.
export function latestCampaignEntries(
  entries: readonly CampaignEntry[],
  bank: { bankId: string; bankRevision: string },
  summary?: PublicCurrentSummary,
): CampaignEntry[] {
  const latest = new Map<string, CampaignEntry>();
  for (const entry of entries) {
    if (
      entry.bankId === bank.bankId &&
      entry.bankRevision === bank.bankRevision
    )
      latest.set(`${entry.campaignId}:${entry.stage}`, entry);
  }
  if (summary) {
    const source = summary.sources.base;
    const pinned = entries.findLast(
      (entry) =>
        entry.bankId === source.bankId &&
        entry.bankRevision === summary.bankRevision &&
        entry.campaignId === source.campaignId &&
        entry.stage === summary.stage,
    );
    if (
      summary.kind !== 'current-task-summary' ||
      summary.policy !== 'latest-complete-task-condition' ||
      summary.bankRevision !== bank.bankRevision ||
      !pinned ||
      pinned.file !== source.file ||
      pinned.reportIdentity !== source.reportIdentity
    )
      throw new Error('Current summary source is missing or superseded');
    // Only this explicitly selected source may cross the current Bank boundary.
    // Its identity is checked again against the loaded snapshot and task result.
    latest.set(`${pinned.campaignId}:${pinned.stage}`, pinned);
  }
  return Array.from(latest, ([, entry]) => entry);
}

export function bindPublishedCohort(
  entry: CampaignEntry,
  data: PublicCampaign,
): PublishedCohort {
  if (
    data.bankId !== entry.bankId ||
    data.bankRevision !== entry.bankRevision ||
    data.campaignId !== entry.campaignId ||
    data.reportIdentity !== entry.reportIdentity ||
    data.stage !== entry.stage ||
    new Set(data.models.map((model) => model.profile.id)).size !==
      data.models.length
  )
    throw new Error('Campaign does not match its published identity');
  return { file: entry.file, data };
}

// This is a source-preserving view, not a combined experiment or recalculation.
export function publishedModelRows(
  cohorts: readonly PublishedCohort[],
): PublishedModelRow[] {
  return completePublishedCohorts(cohorts).flatMap(({ file, data }) =>
    data.models
      .filter((model) => isCompleteModel(model))
      .map((model) => ({
        ...model,
        key: `${data.campaignId}:${model.profile.id}`,
        source: data,
        file,
      })),
  );
}

export function bindCurrentSummary(
  rows: readonly PublishedModelRow[],
  summary: PublicCurrentSummary,
  latest: PublicTaskResult,
): PublishedModelRow[] {
  const base = summary.sources.base;
  const taskSource = summary.sources.task;
  const match = rows.find(
    (row) =>
      row.source.campaignId === base.campaignId &&
      row.source.reportIdentity === base.reportIdentity &&
      row.source.bankId === base.bankId &&
      row.source.bankRevision === summary.bankRevision &&
      row.source.stage === summary.stage &&
      row.file === base.file &&
      row.profile.id === summary.modelProfileId,
  );
  if (
    summary.kind !== 'current-task-summary' ||
    summary.policy !== 'latest-complete-task-condition' ||
    !match?.report?.complete ||
    latest.identity !== taskSource.identity ||
    latest.bankId !== taskSource.bankId ||
    latest.reportIdentity !== taskSource.reportIdentity ||
    latest.campaignId !== taskSource.campaignId ||
    latest.profile.id !== summary.modelProfileId ||
    latest.taskId !== taskSource.taskId ||
    latest.condition !== taskSource.condition ||
    !latest.complete
  )
    throw new Error('Current summary source identity differs');
  const rate = latest.counts.passed / latest.counts.valid;
  const updated = {
    ...match,
    key: summary.identity,
    summary,
    report: {
      ...match.report,
      executions: summary.selectedExecutions,
      counts: summary.counts,
      macro: summary.macro,
      liftPercentagePoints: summary.differencePercentagePoints,
      domains: summary.domains.map((domain) => ({
        ...domain,
        liftPercentagePoints: domain.differencePercentagePoints,
      })),
      measurements: match.report.measurements
        ? { ...match.report.measurements, ...summary.measurements }
        : undefined,
      tasks: match.report.tasks.map((task) =>
        task.id === latest.taskId
          ? {
              ...task,
              comparison: {
                planned: latest.counts.planned,
                valid: 0,
                regressed: 0,
                liftPercentagePoints: null,
                pairs: [],
              },
              conditions: {
                ...task.conditions,
                [latest.condition]: {
                  ...latest.counts,
                  coverage: 1,
                  bounds: [rate, rate] as [number, number],
                  measurements: latest.measurements,
                  repetitions: latest.repetitions.map((attempt) => ({
                    ...attempt,
                    attemptCount: 1,
                    attempts: [],
                    activation: null,
                    attribution: null,
                  })),
                },
              },
            }
          : task,
      ),
    },
  };
  return rows.map((row) => (row === match ? updated : row));
}
