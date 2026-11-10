import {
  type BatchKind,
  createExperiment,
  type ExperimentInputs,
  type ExperimentManifest,
} from './experiment.ts';
import { contentIdentity } from './identity.ts';
import {
  assertDigest,
  type ModelProfile,
  verifyModelProfile,
} from './model-profile.ts';
import { type TaskBankRevision, verifyTaskBank } from './task-bank.ts';

export interface CampaignManifest {
  version: 1;
  id: string;
  seed: string;
  bank: TaskBankRevision;
  suiteAdmissionId: string;
  common: Omit<
    ExperimentInputs,
    | 'kind'
    | 'seed'
    | 'tasks'
    | 'conditions'
    | 'bank'
    | 'modelProfile'
    | 'campaignId'
    | 'commonContractId'
  >;
  profiles: ModelProfile[];
  commonContractId: string;
  skillDigest: string;
  budgetAnchorId: string;
  orderingVersion: 1;
  comparability: 'strict' | 'native-profile';
}
export function createCampaign(
  input: Omit<
    CampaignManifest,
    'version' | 'id' | 'commonContractId' | 'orderingVersion'
  >,
): CampaignManifest {
  verifyTaskBank(input.bank);
  if (
    !input.seed ||
    input.profiles.length === 0 ||
    new Set(input.profiles.map((p) => p.id)).size !== input.profiles.length ||
    !['strict', 'native-profile'].includes(input.comparability)
  )
    throw new Error('Invalid campaign roster');
  for (const profile of input.profiles) verifyModelProfile(profile);
  for (const d of [
    input.suiteAdmissionId,
    input.budgetAnchorId,
    input.skillDigest,
    ...Object.values(input.common),
  ])
    assertDigest(d);
  const first = input.profiles[0]!;
  if (
    input.profiles.some(
      (p) => contentIdentity(p.codex) !== contentIdentity(first.codex),
    )
  )
    throw new Error('Campaign requires the same Codex agent');
  if (
    input.comparability === 'strict' &&
    input.profiles.some(
      (p) =>
        p.instructionDigest !== first.instructionDigest ||
        p.reasoningEffort !== first.reasoningEffort ||
        p.requestedServiceTier !== first.requestedServiceTier ||
        contentIdentity(p.execution) !== contentIdentity(first.execution),
    )
  )
    throw new Error('Model defaults are not strictly comparable');
  const body = {
    version: 1 as const,
    ...structuredClone(input),
    profiles: structuredClone(input.profiles).toSorted((a, b) =>
      a.id.localeCompare(b.id),
    ),
    orderingVersion: 1 as const,
    commonContractId: contentIdentity({
      common: input.common,
      bankId: input.bank.id,
      skillDigest: input.skillDigest,
    }),
  };
  return { ...body, id: contentIdentity(body) };
}
export function verifyCampaign(c: CampaignManifest): void {
  const { version, id, commonContractId, orderingVersion, ...input } = c;
  if (
    version !== 1 ||
    orderingVersion !== 1 ||
    contentIdentity(createCampaign(input)) !== contentIdentity(c)
  )
    throw new Error('Campaign identity changed');
  assertDigest(id);
  assertDigest(commonContractId);
}
export function campaignExperiment(
  c: CampaignManifest,
  profileId: string,
  kind: BatchKind,
  candidateDigest?: string,
): ExperimentManifest {
  verifyCampaign(c);
  const profile = c.profiles.find((p) => p.id === profileId);
  if (!profile) throw new Error('Model outside campaign roster');
  const tasks = c.bank.tasks
    .filter((t) =>
      kind === 'smoke'
        ? t.id === 'I01'
        : kind === 'pilot'
          ? [
              'I01',
              'C01',
              'R02',
              'K01',
              'S01',
              'W02',
              'T01',
              'P01',
              'N01',
            ].includes(t.id)
          : kind === 'confirmation' ||
            t.split === (kind === 'development' ? 'dev' : 'sealed'),
    )
    .map(
      ({ id, domain, split, specDigest, executionDigest, gradingDigest }) => ({
        id,
        domain,
        split,
        specDigest,
        executionDigest,
        gradingDigest,
      }),
    );
  const ids =
    kind === 'smoke'
      ? (['base', 'skill', 'explicit-skill'] as const)
      : kind === 'confirmation'
        ? (['base', 'skill', 'candidate'] as const)
        : (['base', 'skill'] as const);
  return createExperiment({
    ...c.common,
    kind,
    seed: c.seed,
    tasks,
    conditions: ids.map((id) => ({
      id,
      skillDigest:
        id === 'base'
          ? null
          : id === 'candidate'
            ? (candidateDigest ?? '')
            : c.skillDigest,
    })),
    modelProfile: profile,
    bank: c.bank,
    campaignId: c.id,
    commonContractId: c.commonContractId,
  });
}
export function campaignParticipants(
  c: CampaignManifest,
  ids = c.profiles.map((p) => p.id),
): ModelProfile[] {
  verifyCampaign(c);
  if (
    new Set(ids).size !== ids.length ||
    ids.some((id) => c.profiles.every((p) => p.id !== id))
  )
    throw new Error('Participant roster differs from campaign');
  return c.profiles.filter((p) => ids.includes(p.id));
}
export interface ScheduledSlot {
  modelProfileId: string;
  experimentIdentity: string;
  slotId: string;
  block: string;
}
export function campaignSchedule(
  c: CampaignManifest,
  kind: BatchKind,
  candidateDigest?: string,
  admittedProfileIds?: string[],
): ScheduledSlot[] {
  verifyCampaign(c);
  const participants = campaignParticipants(c, admittedProfileIds);
  if (participants.length === 0) return [];
  const plans = participants.map((p) =>
    campaignExperiment(c, p.id, kind, candidateDigest),
  );
  const blocks = [...new Set(plans[0]!.slots.map((s) => s.block))];
  const profiles = participants.toSorted((a, b) =>
    contentIdentity({ seed: c.seed, model: a.id }).localeCompare(
      contentIdentity({ seed: c.seed, model: b.id }),
    ),
  );
  const out: ScheduledSlot[] = [];
  for (const [index, block] of blocks.entries()) {
    const offset = index % profiles.length;
    const orderedProfiles = [
      ...profiles.slice(offset),
      ...profiles.slice(0, offset),
    ];
    for (const profile of orderedProfiles) {
      const plan = plans.find((p) => p.inputs.modelProfile!.id === profile.id)!;
      for (const slot of plan.slots) {
        if (slot.block !== block) continue;
        out.push({
          modelProfileId: profile.id,
          experimentIdentity: plan.identity,
          slotId: slot.id,
          block,
        });
      }
    }
  }
  return out;
}
