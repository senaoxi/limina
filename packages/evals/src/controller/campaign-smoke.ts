import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  campaignExperiment,
  type CampaignManifest,
  campaignParticipants,
} from '../core/campaign.ts';
import { contentIdentity } from '../core/identity.ts';
import { RunStore } from '../core/run-store.ts';
import { sha256 } from '../core/snapshot.ts';

interface SmokeCompletion {
  version: 1;
  campaignId: string;
  runs: {
    profileId: string;
    directory: string;
    journalBytes: number;
    journalSha256: string;
  }[];
}
export function admittedSmokeProfiles(
  campaign: CampaignManifest,
  completion: SmokeCompletion,
): Set<string> {
  if (
    completion.version !== 1 ||
    completion.campaignId !== campaign.id ||
    new Set(completion.runs.map((r) => r.profileId)).size !==
      completion.runs.length
  )
    throw new Error('Smoke completion differs from campaign');
  const admitted = new Set<string>();
  for (const source of completion.runs) {
    const store = RunStore.openAt(
      source.directory,
      source.journalBytes,
      source.journalSha256,
    );
    const expected = campaignExperiment(campaign, source.profileId, 'smoke');
    if (contentIdentity(store.manifest) !== contentIdentity(expected))
      throw new Error('Smoke belongs to another profile or experiment');
    const summary = store.summary();
    if (
      !summary.inFlight &&
      summary.slots.every(
        (slot) =>
          slot.status === 'passed' &&
          slot.evidenceStatus === 'complete' &&
          slot.selected?.usage?.complete &&
          slot.selected.facts.mutation?.status === 'accepted' &&
          slot.selected.facts.mutation.changes.length > 0 &&
          slot.selected.observedModelId === store.manifest.policy.model,
      )
    )
      admitted.add(source.profileId);
  }
  return admitted;
}
export async function writeSmokeCompletion(
  campaign: CampaignManifest,
  directory: string,
  stores: Map<string, RunStore>,
) {
  const runs = [];
  for (const [profileId, store] of stores) {
    const bytes = await readFile(path.join(store.directory, 'attempts.jsonl'));
    runs.push({
      profileId,
      directory: store.directory,
      journalBytes: bytes.length,
      journalSha256: sha256(bytes),
    });
  }
  const result: SmokeCompletion = { version: 1, campaignId: campaign.id, runs };
  admittedSmokeProfiles(campaign, result);
  const file = path.join(directory, 'smoke-completion.json');
  const text = `${JSON.stringify(result)}\n`;
  try {
    await writeFile(file, text, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
      (await readFile(file, 'utf8')) !== text
    )
      throw error;
  }
  return result;
}
export async function readSmokeAdmission(
  campaign: CampaignManifest,
  directory: string,
) {
  const text = await readFile(
    path.join(directory, 'smoke-completion.json'),
    'utf8',
  );
  return admittedSmokeProfiles(campaign, JSON.parse(text) as SmokeCompletion);
}

export function validateDecisionRoster(
  campaign: CampaignManifest,
  admitted: Set<string>,
  decision: {
    models: { profileId: string }[];
    notAdmittedProfileIds?: string[];
  },
) {
  const participants = campaignParticipants(campaign, [...admitted]);
  const excluded = campaign.profiles
    .filter((p) => !admitted.has(p.id))
    .map((p) => p.id)
    .toSorted((a, b) => a.localeCompare(b));
  if (
    decision.models.length !== participants.length ||
    new Set(decision.models.map((m) => m.profileId)).size !==
      decision.models.length ||
    decision.models.some((m) => !admitted.has(m.profileId)) ||
    contentIdentity(
      [...(decision.notAdmittedProfileIds ?? [])].toSorted((a, b) =>
        a.localeCompare(b),
      ),
    ) !== contentIdentity(excluded)
  )
    throw new Error(
      'Common decision must cover admitted models and retain excluded roster',
    );
  return participants;
}
