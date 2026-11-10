import type { FailureAttribution } from './attribution.ts';
import type { BudgetManager } from './budget.ts';
import type { CampaignMeasurements } from './campaign-measurements.ts';
import {
  campaignExperiment,
  type CampaignManifest,
  verifyCampaign,
} from './campaign.ts';
import type {
  BatchKind,
  ConditionId,
  ExperimentManifest,
} from './experiment.ts';
import { contentIdentity } from './identity.ts';
import { buildReport } from './report.ts';
import type { RunStore } from './run-store.ts';

type Summary = ReturnType<RunStore['summary']>;
type Budget = ReturnType<BudgetManager['summary']>;
type Slot = Summary['slots'][number];
const known = new Set([
  'passed',
  'assertion_failed',
  'unsafe_mutation',
  'agent_error',
  'agent_timeout',
]);
export const mainDomains = [
  'initialization',
  'configuration',
  'reference-graph',
  'checker',
  'source-governance',
  'workflow',
  'troubleshooting',
  'package-release',
] as const;
const avg = (v: number[]) =>
  v.length > 0 ? v.reduce((a, b) => a + b, 0) / v.length : null;
function metric(slots: Slot[]) {
  const valid = slots.filter((s) => known.has(s.status));
  const passed = valid.filter((s) => s.status === 'passed').length;
  return {
    planned: slots.length,
    valid: valid.length,
    passed,
    rate: valid.length > 0 ? passed / valid.length : null,
    coverage: slots.length > 0 ? valid.length / slots.length : 0,
    bounds:
      slots.length > 0
        ? ([
            passed / slots.length,
            (passed + slots.length - valid.length) / slots.length,
          ] as [number, number])
        : null,
    statuses: Object.fromEntries(
      [...new Set(slots.map((s) => s.status))].map((status) => [
        status,
        slots.filter((s) => s.status === status).length,
      ]),
    ),
  };
}
function paired(slots: Slot[], treatment: ConditionId = 'skill') {
  const pairs = slots
    .filter((s) => s.slot.condition === treatment)
    .map((s) => {
      const b = slots.find(
        (b) => b.slot.condition === 'base' && b.slot.block === s.slot.block,
      );
      const base =
        b && known.has(b.status) ? Number(b.status === 'passed') : null;
      const skill = known.has(s.status) ? Number(s.status === 'passed') : null;
      if (b && b.slot.comparisonIdentity !== s.slot.comparisonIdentity)
        throw new Error('Pair comparison identity differs');
      return {
        taskId: s.slot.taskId,
        repetition: s.slot.repetition,
        base,
        skill,
        delta: base !== null && skill !== null ? skill - base : null,
        bounds: [(skill ?? 0) - (base ?? 1), (skill ?? 1) - (base ?? 0)] as [
          number,
          number,
        ],
      };
    });
  const valid = pairs.filter((p) => p.delta !== null);
  return {
    planned: pairs.length,
    valid: valid.length,
    liftPercentagePoints: avg(valid.map((p) => 100 * p.delta!)),
    regressionRate: avg(
      valid.map((p) => Number(p.base === 1 && p.skill === 0)),
    ),
    improved: valid.filter((p) => p.delta === 1).length,
    regressed: valid.filter((p) => p.delta === -1).length,
    bothPassed: valid.filter((p) => p.base === 1 && p.skill === 1).length,
    bothFailed: valid.filter((p) => p.base === 0 && p.skill === 0).length,
    unpaired: pairs.length - valid.length,
    bounds:
      pairs.length > 0
        ? ([
            100 * avg(pairs.map((p) => p.bounds[0]))!,
            100 * avg(pairs.map((p) => p.bounds[1]))!,
          ] as [number, number])
        : null,
    pairs,
  };
}
export interface ModelReportInput {
  manifest: ExperimentManifest;
  summary: Summary;
  budget: Budget;
  attributions: FailureAttribution[];
  measurements?: CampaignMeasurements;
}
export function buildCampaignReport(
  c: CampaignManifest,
  kind: BatchKind,
  inputs: ModelReportInput[],
  sourceIndexDigest: string,
  candidateDigest?: string,
  notAdmittedProfileIds: readonly string[] = [],
) {
  verifyCampaign(c);
  if (
    new Set(inputs.map((index) => index.manifest.inputs.modelProfile?.id))
      .size !== inputs.length ||
    inputs.some((index) =>
      c.profiles.every((p) => p.id !== index.manifest.inputs.modelProfile?.id),
    )
  )
    throw new Error('Duplicate or foreign model report');
  if (
    new Set(notAdmittedProfileIds).size !== notAdmittedProfileIds.length ||
    notAdmittedProfileIds.some(
      (id) =>
        c.profiles.every((p) => p.id !== id) ||
        inputs.some((input) => input.manifest.inputs.modelProfile?.id === id),
    )
  )
    throw new Error('Admission contradicts recorded model inputs');
  const models = c.profiles.map((profile) => {
    const expected = campaignExperiment(c, profile.id, kind, candidateDigest);
    const model = { profile, planned: expected.slots.length };
    const input = inputs.find(
      (index) => index.manifest.inputs.modelProfile?.id === profile.id,
    );
    if (!input)
      return {
        ...model,
        status: notAdmittedProfileIds.includes(profile.id)
          ? ('not_admitted' as const)
          : ('missing' as const),
        report: null,
      };
    if (contentIdentity(input.manifest) !== contentIdentity(expected))
      throw new Error('Report experiment differs from campaign');
    const baseReport = buildReport(input.manifest, input.summary, input.budget);
    const tasks = input.manifest.inputs.tasks.map((task) => {
      const slots = input.summary.slots.filter(
        (s) => s.slot.taskId === task.id,
      );
      const conditions = Object.fromEntries(
        input.manifest.inputs.conditions.map(({ id }) => [
          id,
          {
            ...metric(slots.filter((s) => s.slot.condition === id)),
            repetitions: slots
              .filter((s) => s.slot.condition === id)
              .map((s) => ({
                repetition: s.slot.repetition,
                status: s.status,
                runId: s.selected?.runId ?? null,
                attempts: input.summary.attempts
                  .filter((a) => a.slot.id === s.slot.id)
                  .map((a) => ({
                    runId: a.runId,
                    ordinal: a.ordinal,
                    status: a.outcome.status,
                  })),
                activation: s.selected?.activationEvidence ?? null,
                attribution:
                  input.attributions.findLast(
                    (a) => a.runId === s.selected?.runId,
                  ) ?? null,
              })),
          },
        ]),
      );
      return {
        id: task.id,
        domain: task.domain,
        fixtureIdentity: c.bank.tasks.find((t) => t.id === task.id)!
          .fixtureDigest,
        gradingIdentity: slots[0]!.slot.gradingIdentity,
        executionIdentity: task.executionDigest,
        role:
          task.domain === 'negative-control'
            ? ('negative-control' as const)
            : ('main' as const),
        conditions,
        comparison: paired(slots),
      };
    });
    const domains = mainDomains.map((id) => {
      const group = tasks.filter((t) => t.domain === id);
      const conditions = Object.fromEntries(
        input.manifest.inputs.conditions.map(({ id }) => [
          id,
          group.length > 0 &&
          group.every((t) => t.conditions[id]!.rate !== null)
            ? avg(group.map((t) => t.conditions[id]!.rate!))
            : null,
        ]),
      );
      return {
        id,
        taskCount: group.length,
        conditions,
        liftPercentagePoints:
          group.length > 0 &&
          group.every((t) => t.comparison.liftPercentagePoints !== null)
            ? avg(group.map((t) => t.comparison.liftPercentagePoints!))
            : null,
        regressionRate:
          group.length > 0 &&
          group.every((t) => t.comparison.regressionRate !== null)
            ? avg(group.map((t) => t.comparison.regressionRate!))
            : null,
      };
    });
    const macro = Object.fromEntries(
      input.manifest.inputs.conditions.map(({ id }) => [
        id,
        domains.every((d) => d.conditions[id] !== null)
          ? avg(domains.map((d) => d.conditions[id]!))
          : null,
      ]),
    );
    return {
      ...model,
      status: 'recorded' as const,
      report: {
        experimentIdentity: input.manifest.identity,
        planned: input.manifest.slots.length,
        executions: input.summary.attempts.length,
        complete: !baseReport.provisional,
        macro,
        liftPercentagePoints: domains.every(
          (d) => d.liftPercentagePoints !== null,
        )
          ? avg(domains.map((d) => d.liftPercentagePoints!))
          : null,
        regressionRate: domains.every((d) => d.regressionRate !== null)
          ? avg(domains.map((d) => d.regressionRate!))
          : null,
        tasks,
        domains,
        negativeControls: tasks.filter((t) => t.role === 'negative-control'),
        usage: baseReport.usage,
        time: baseReport.time,
        ...(input.measurements && { measurements: input.measurements }),
      },
    };
  });
  const contrasts = [];
  for (let a = 0; a < models.length; a++)
    for (let b = a + 1; b < models.length; b++) {
      const left = models[a]!;
      const right = models[b]!;
      const comparable =
        c.comparability === 'strict' &&
        left.report?.complete &&
        right.report?.complete &&
        left.report.macro.base !== null &&
        right.report.macro.base !== null &&
        left.report.liftPercentagePoints !== null &&
        right.report.liftPercentagePoints !== null;
      contrasts.push({
        left: left.profile.id,
        right: right.profile.id,
        strictlyComparable: Boolean(comparable),
        baseDifferencePercentagePoints: comparable
          ? 100 * (left.report!.macro.base! - right.report!.macro.base!)
          : null,
        modelBySkillPercentagePoints: comparable
          ? left.report!.liftPercentagePoints! -
            right.report!.liftPercentagePoints!
          : null,
      });
    }
  const body = {
    version: 2 as const,
    campaignId: c.id,
    comparability: c.comparability,
    bankId: c.bank.id,
    bankRevision: c.bank.revision,
    stage: kind,
    commonContractId: c.commonContractId,
    sourceIndexDigest,
    analysisPolicyDigest: contentIdentity({
      version: 1,
      itt: true,
      domains: 'equal',
      tasks: 'equal',
      unresolved: 'bounds',
      significance: false,
      modelEvidence: 'required-for-v2-determinable-slots',
    }),
    exploratory: true,
    significantImprovementClaim: false,
    models,
    contrasts,
  };
  return { ...body, identity: contentIdentity(body) };
}
export type CampaignReport = ReturnType<typeof buildCampaignReport>;
