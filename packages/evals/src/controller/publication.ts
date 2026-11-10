import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { causes } from '../core/attribution.ts';
import type {
  AveragedMeasurement,
  ExecutionMeasurements,
} from '../core/campaign-measurements.ts';
import {
  buildCampaignReport,
  type CampaignReport,
  mainDomains,
} from '../core/campaign-report.ts';
import type { CampaignManifest } from '../core/campaign.ts';
import { resolveApiPricing } from '../core/estimated-cost.ts';
import { contentIdentity } from '../core/identity.ts';
import { assertDigest, verifyModelProfile } from '../core/model-profile.ts';
import { sha256 } from '../core/snapshot.ts';
import { isBankRevision } from '../core/task-bank.ts';
import {
  campaignCalculationDigest,
  campaignReportAdmissions,
  campaignReportInputs,
  type CampaignSourceIndex,
  verifyCampaignBudget,
} from './campaign-report.ts';
function numeric(value: number | null): number | null {
  assert.ok(value === null || Number.isFinite(value));
  return value;
}
function metric(c: {
  planned: number;
  valid: number;
  passed: number;
  rate: number | null;
  coverage: number;
  bounds: [number, number] | null;
  statuses: Record<string, number>;
}) {
  for (const n of [c.planned, c.valid, c.passed])
    assert.ok(Number.isSafeInteger(n) && n >= 0);
  return {
    planned: c.planned,
    valid: c.valid,
    passed: c.passed,
    rate: numeric(c.rate),
    coverage: numeric(c.coverage)!,
    bounds: c.bounds?.map((n) => numeric(n)) ?? null,
  };
}
const observe = (o: { state: string } | undefined) =>
  o && ['yes', 'no', 'unknown'].includes(o.state) ? o.state : 'unknown';
function averaged(m: AveragedMeasurement) {
  for (const n of [m.measured, m.executions, m.cells, m.measuredCells])
    assert.ok(Number.isSafeInteger(n) && n >= 0);
  assert.ok(m.measured <= m.executions && m.measuredCells <= m.cells);
  for (const n of [m.mean, m.observedSum, m.total])
    assert.ok(n === null || (Number.isFinite(n) && n >= 0));
  assert.equal(m.coverage, m.executions ? m.measured / m.executions : 0);
  assert.equal(m.mean === null, m.measuredCells === 0);
  assert.equal(
    m.total === null,
    m.executions === 0 || m.measured !== m.executions,
  );
  return {
    mean: m.mean,
    observedSum: m.observedSum,
    total: m.total,
    measured: m.measured,
    executions: m.executions,
    coverage: m.coverage,
    cells: m.cells,
    measuredCells: m.measuredCells,
  };
}
function measurements(m: ExecutionMeasurements) {
  return {
    ...(m.inputTokens && { inputTokens: averaged(m.inputTokens) }),
    agentMs: averaged(m.agentMs),
    endToEndMs: averaged(m.endToEndMs),
    apiEquivalentUsd: averaged(m.apiEquivalentUsd),
    settledUsd: averaged(m.settledUsd),
  };
}
export function publicCampaign(report: CampaignReport) {
  const { identity, ...body } = report;
  assert.equal(identity, contentIdentity(body), 'Report identity differs');
  for (const d of [
    report.campaignId,
    report.bankId,
    report.commonContractId,
    report.sourceIndexDigest,
    report.analysisPolicyDigest,
  ])
    assertDigest(d);
  assert.equal(report.version, 2);
  assert.ok(['strict', 'native-profile'].includes(report.comparability));
  assert.equal(report.exploratory, true);
  assert.equal(report.significantImprovementClaim, false);
  assert.ok(isBankRevision(report.bankRevision));
  assert.ok(
    ['smoke', 'pilot', 'development', 'sealed', 'confirmation'].includes(
      report.stage,
    ),
  );
  const status = (value: string) => {
    assert.ok(
      [
        'passed',
        'assertion_failed',
        'unsafe_mutation',
        'agent_error',
        'agent_timeout',
        'infra_error',
        'grader_error',
        'unknown',
        'cancelled',
        'not_run',
        'in_flight',
      ].includes(value),
    );
    return value;
  };
  const comparison = (
    c: NonNullable<
      CampaignReport['models'][number]['report']
    >['tasks'][number]['comparison'],
  ) => ({
    planned: c.planned,
    valid: c.valid,
    liftPercentagePoints: numeric(c.liftPercentagePoints),
    regressionRate: numeric(c.regressionRate),
    improved: c.improved,
    regressed: c.regressed,
    bothPassed: c.bothPassed,
    bothFailed: c.bothFailed,
    unpaired: c.unpaired,
    bounds: c.bounds?.map((n) => numeric(n)) ?? null,
    pairs: c.pairs.map((p) => ({
      taskId: p.taskId,
      repetition: p.repetition,
      base: p.base,
      skill: p.skill,
      delta: p.delta,
      bounds: [p.bounds[0], p.bounds[1]],
    })),
  });
  return {
    schemaVersion: 2 as const,
    campaignId: report.campaignId,
    comparability: report.comparability,
    bankId: report.bankId,
    bankRevision: report.bankRevision,
    stage: report.stage,
    sourceIndexDigest: report.sourceIndexDigest,
    analysisPolicyDigest: report.analysisPolicyDigest,
    reportIdentity: identity,
    exploratory: true,
    models: report.models.map((m) => {
      assert.ok(['recorded', 'not_admitted', 'missing'].includes(m.status));
      verifyModelProfile(m.profile);
      const profile = {
        id: m.profile.id,
        model: m.profile.canonicalModelId,
        displayName: m.profile.displayName,
        provider: m.profile.providerId,
        reasoningEffort: m.profile.reasoningEffort,
        serviceTier: m.profile.requestedServiceTier,
        serviceTierEvidence: 'requested-only' as const,
        codexVersion: m.profile.codex.version,
        codexBinaryIdentity: m.profile.codex.sha256,
        instructionIdentity: m.profile.instructionDigest,
        execution: {
          contextWindow: m.profile.execution.contextWindow,
          autoCompactTokenLimit: m.profile.execution.autoCompactTokenLimit,
          toolOutputLimit: m.profile.execution.toolOutputLimit,
        },
      };
      const r = m.report;
      if (!r)
        return { profile, planned: m.planned, status: m.status, report: null };
      const conditions = (values: Record<string, number | null>) =>
        Object.fromEntries(
          ['base', 'skill', 'candidate', 'explicit-skill']
            .filter((id) => Object.hasOwn(values, id))
            .map((id) => [id, numeric(values[id]!)]),
        );
      const measured = r.measurements;
      if (measured) {
        const pricing = resolveApiPricing(measured.pricing.identity);
        assert.ok(measured.version === 1 || measured.version === 2);
        assert.equal(measured.policy, 'task-condition-equal-all-executions');
        assert.equal(measured.pricing.version, pricing.version);
        assert.equal(measured.pricing.observedOn, pricing.observedOn);
      }
      const countConditions = (tasks: typeof r.tasks) =>
        Object.fromEntries(
          ['base', 'skill', 'candidate', 'explicit-skill']
            .filter((id) => tasks.some((t) => t.conditions[id]))
            .map((id) => {
              const values = tasks.flatMap((t) =>
                Object.hasOwn(t.conditions, id) ? [t.conditions[id]!] : [],
              );
              return [
                id,
                {
                  passed: values.reduce((n, c) => n + c.passed, 0),
                  valid: values.reduce((n, c) => n + c.valid, 0),
                  planned: values.reduce((n, c) => n + c.planned, 0),
                  executions: values.reduce(
                    (n, c) =>
                      n +
                      c.repetitions.reduce((n, r) => n + r.attempts.length, 0),
                    0,
                  ),
                },
              ];
            }),
        );
      const measuredGroup = (g: NonNullable<typeof measured>['main']) => ({
        all: measurements(g.all),
        conditions: Object.fromEntries(
          ['base', 'skill', 'candidate', 'explicit-skill']
            .filter((id) => g.conditions[id])
            .map((id) => [id, measurements(g.conditions[id]!)]),
        ),
      });
      return {
        profile,
        planned: m.planned,
        status: m.status,
        report: {
          experimentIdentity: r.experimentIdentity,
          planned: r.planned,
          executions: r.executions,
          complete: r.complete,
          macro: conditions(r.macro),
          liftPercentagePoints: numeric(r.liftPercentagePoints),
          regressionRate: numeric(r.regressionRate),
          counts: countConditions(r.tasks.filter((t) => t.role === 'main')),
          ...(measured && {
            measurements: {
              version: measured.version,
              policy: 'task-condition-equal-all-executions' as const,
              pricing: {
                identity: measured.pricing.identity,
                version: measured.pricing.version,
                observedOn: measured.pricing.observedOn,
              },
              main: measuredGroup(measured.main),
              negativeControls: measuredGroup(measured.negativeControls),
            },
          }),
          domains: r.domains.map((d) => {
            assert.ok(mainDomains.includes(d.id));
            return {
              id: d.id,
              taskCount: d.taskCount,
              counts: countConditions(r.tasks.filter((t) => t.domain === d.id)),
              conditions: conditions(d.conditions),
              liftPercentagePoints: numeric(d.liftPercentagePoints),
              regressionRate: numeric(d.regressionRate),
            };
          }),
          tasks: r.tasks.map((t) => {
            assert.match(t.id, /^[A-Z]\d{2}$/);
            assert.ok(
              t.domain === 'negative-control' ||
                mainDomains.includes(t.domain as (typeof mainDomains)[number]),
            );
            assert.ok(['main', 'negative-control'].includes(t.role));
            return {
              id: t.id,
              domain: t.domain,
              role: t.role,
              fixtureIdentity: t.fixtureIdentity,
              gradingIdentity: t.gradingIdentity,
              executionIdentity: t.executionIdentity,
              ...(measured?.version === 2 && {
                measurements: measurements(
                  measured.tasks.find((m) => m.id === t.id)!.all!,
                ),
              }),
              comparison: comparison(t.comparison),
              conditions: Object.fromEntries(
                ['base', 'skill', 'candidate', 'explicit-skill']
                  .filter((id) => t.conditions[id])
                  .map((id) => {
                    const c = t.conditions[id]!;
                    return [
                      id,
                      {
                        ...metric(c),
                        executions: c.repetitions.reduce(
                          (n, r) => n + r.attempts.length,
                          0,
                        ),
                        ...(measured && {
                          measurements: measurements(
                            measured.tasks.find((m) => m.id === t.id)!
                              .conditions[id]!,
                          ),
                        }),
                        repetitions: c.repetitions.map((r) => ({
                          repetition: r.repetition,
                          status: status(r.status),
                          attemptCount: r.attempts.length,
                          attempts: r.attempts.map((a) => ({
                            id: contentIdentity(a.runId),
                            ordinal: a.ordinal,
                            status: status(a.status),
                          })),
                          attemptStatuses: r.attempts.map((a) =>
                            status(a.status),
                          ),
                          activation: r.activation
                            ? {
                                installed: observe(r.activation.installed),
                                discoverable: observe(
                                  r.activation.discoverable,
                                ),
                                discovered: observe(r.activation.discovered),
                                skillRead: observe(r.activation.skillRead),
                                referencesRead: Object.values(
                                  r.activation.referenceReads,
                                ).filter((o) => observe(o) === 'yes').length,
                                followed: observe(r.activation.followed),
                              }
                            : null,
                          attribution:
                            r.attribution &&
                            causes.includes(r.attribution.primary) &&
                            ['unknown', 'low', 'medium', 'high'].includes(
                              r.attribution.confidence,
                            ) &&
                            [
                              'unreviewed',
                              'proposed',
                              'reviewed',
                              'disputed',
                            ].includes(r.attribution.adjudication)
                              ? {
                                  primary: r.attribution.primary,
                                  contributing:
                                    r.attribution.contributing.filter((c) =>
                                      causes.includes(c),
                                    ),
                                  confidence: r.attribution.confidence,
                                  adjudication: r.attribution.adjudication,
                                }
                              : null,
                        })),
                      },
                    ];
                  }),
              ),
            };
          }),
        },
      };
    }),
    contrasts: report.contrasts.map((c) => ({
      left: c.left,
      right: c.right,
      strictlyComparable: c.strictlyComparable,
      baseDifferencePercentagePoints: numeric(c.baseDifferencePercentagePoints),
      modelBySkillPercentagePoints: numeric(c.modelBySkillPercentagePoints),
    })),
  };
}
export type PublicCampaign = ReturnType<typeof publicCampaign>;
export async function readCampaignPublication(
  directory: string,
  expectedIndexHash: string,
) {
  assertDigest(expectedIndexHash);
  const bytes = await readFile(path.join(directory, 'source-index.json'));
  assert.equal(
    sha256(bytes),
    expectedIndexHash,
    'Source index integrity differs',
  );
  const index = JSON.parse(bytes.toString()) as CampaignSourceIndex;
  const { identity, reportSha256, ...body } = index;
  assert.equal(identity, contentIdentity(body));
  assert.equal(index.version, 1);
  assert.equal(
    index.calculationDigest,
    await campaignCalculationDigest(),
    'Calculation source differs',
  );
  const campaignBytes = await readFile(index.campaignFile);
  assert.equal(sha256(campaignBytes), index.campaignSha256);
  const campaign = JSON.parse(campaignBytes.toString()) as CampaignManifest;
  await verifyCampaignBudget(
    campaign,
    index.campaignFile,
    index.runs.map((r) => r.budgetFile),
    await readFile(index.ledgerSnapshot.file),
  );
  const reportBytes = await readFile(path.join(directory, 'report.json'));
  assert.equal(sha256(reportBytes), reportSha256);
  const report = JSON.parse(reportBytes.toString()) as CampaignReport;
  const inputs = await campaignReportInputs(campaign, index);
  const expected = buildCampaignReport(
    campaign,
    index.stage,
    inputs,
    identity,
    index.candidateDigest,
    await campaignReportAdmissions(campaign, index),
  );
  assert.equal(
    contentIdentity(report),
    contentIdentity(expected),
    'Report does not match bound attempts',
  );
  return publicCampaign(report);
}
