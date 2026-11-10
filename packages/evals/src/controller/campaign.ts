import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  campaignExperiment,
  type CampaignManifest,
  campaignSchedule,
  createCampaign,
  verifyCampaign,
} from '../core/campaign.ts';
import type { BatchKind } from '../core/experiment.ts';
import { contentIdentity } from '../core/identity.ts';
import type { ModelProfile } from '../core/model-profile.ts';
import type { RunStore } from '../core/run-store.ts';
import { sha256 } from '../core/snapshot.ts';
import { createTaskBank } from '../core/task-bank.ts';
import {
  readSmokeAdmission,
  validateDecisionRoster,
  writeSmokeCompletion,
} from './campaign-smoke.ts';
import {
  type Decision,
  type FileReference,
  loadFormalInputs,
  owned,
  pinned,
  prepareFormalExecution,
} from './formal.ts';
import { freezeAdmittedExperiment } from './suite.ts';

interface CampaignConfig {
  version: 1;
  admission: FileReference;
  directory: string;
  profiles: ModelProfile[];
  comparability: CampaignManifest['comparability'];
  finalDecision?: FileReference;
}
async function readConfig(file: string) {
  await owned(file);
  const config = JSON.parse(await readFile(file, 'utf8')) as CampaignConfig;
  if (
    config.version !== 1 ||
    !path.isAbsolute(config.directory) ||
    (await realpath(path.dirname(config.directory))) !==
      path.dirname(config.directory)
  )
    throw new Error('Invalid campaign configuration');
  await pinned(config.admission);
  return config;
}
async function frozen(config: CampaignConfig): Promise<CampaignManifest> {
  const file = path.join(config.directory, 'campaign.json');
  await owned(file);
  const campaign = JSON.parse(await readFile(file, 'utf8')) as CampaignManifest;
  verifyCampaign(campaign);
  if (
    contentIdentity(campaign.profiles) !==
      contentIdentity(
        [...config.profiles].toSorted((a, b) => a.id.localeCompare(b.id)),
      ) ||
    campaign.comparability !== config.comparability
  )
    throw new Error('Campaign configuration changed');
  const reference = JSON.parse(
    await readFile(path.join(config.directory, 'admission.json'), 'utf8'),
  ) as FileReference;
  if (contentIdentity(reference) !== contentIdentity(config.admission))
    throw new Error('Campaign admission changed');
  const anchor = JSON.parse(
    await readFile(path.join(config.directory, 'budget-anchor.json'), 'utf8'),
  ) as { ledger: string; prefixBytes: number; prefixSha256: string };
  const ledger = await readFile(anchor.ledger);
  if (
    contentIdentity(anchor) !== campaign.budgetAnchorId ||
    (await realpath(anchor.ledger)) !== anchor.ledger ||
    !Number.isSafeInteger(anchor.prefixBytes) ||
    anchor.prefixBytes < 0 ||
    ledger.length < anchor.prefixBytes ||
    sha256(ledger.subarray(0, anchor.prefixBytes)) !== anchor.prefixSha256
  )
    throw new Error('Campaign budget prefix changed');
  return campaign;
}
export async function freezeCampaign(file: string) {
  const config = await readConfig(file);
  const context = await loadFormalInputs(config.admission.file);
  if (
    config.directory === context.control.repository ||
    config.directory.startsWith(context.control.repository + path.sep) ||
    !config.directory.startsWith(context.control.sealedStore + path.sep)
  )
    throw new Error('Campaign belongs in private controller storage');
  const template = await freezeAdmittedExperiment(context.suite, {
    ...context.common,
    kind: 'smoke',
    conditions: [
      { id: 'base', skillDigest: null },
      { id: 'skill', skillDigest: context.original.digest },
      { id: 'explicit-skill', skillDigest: context.original.digest },
    ],
  });
  const common = {
    preparedInputsDigest: template.inputs.preparedInputsDigest,
    runnerDigest: template.inputs.runnerDigest,
    toolchainDigest: template.inputs.toolchainDigest,
    contextDigest: template.inputs.contextDigest,
    imageDigest: template.inputs.imageDigest,
  };
  const ledgerBytes = await readFile(context.budget.path);
  const budgetAnchor = {
    ledger: context.budget.path,
    prefixBytes: ledgerBytes.length,
    prefixSha256: sha256(ledgerBytes),
  };
  const campaign = createCampaign({
    seed: context.control.seed,
    bank: createTaskBank(
      context.control.bankRevision ?? 'v1',
      context.suite.tasks.map((t) => ({ task: t.task, identity: t.identity })),
    ),
    suiteAdmissionId: context.suite.identity,
    common,
    profiles: config.profiles,
    skillDigest: context.original.digest!,
    budgetAnchorId: contentIdentity(budgetAnchor),
    comparability: config.comparability,
  });
  await mkdir(config.directory, { mode: 0o700 });
  await writeFile(
    path.join(config.directory, 'campaign.json'),
    `${JSON.stringify(campaign)}\n`,
    { flag: 'wx', mode: 0o600 },
  );
  await writeFile(
    path.join(config.directory, 'budget-anchor.json'),
    `${JSON.stringify(budgetAnchor)}\n`,
    { flag: 'wx', mode: 0o600 },
  );
  await writeFile(
    path.join(config.directory, 'admission.json'),
    `${JSON.stringify(config.admission)}\n`,
    { flag: 'wx', mode: 0o600 },
  );
  return {
    campaignId: campaign.id,
    models: campaign.profiles.length,
    bankId: campaign.bank.id,
  };
}

/** The campaign lock covers every awaited preparation and dispatch. A crash leaves
 * the lock and journals for explicit reconciliation, never an automatic retry. */
export async function runCampaignSchedule(
  c: CampaignManifest,
  kind: BatchKind,
  directory: string,
  stores: Map<string, RunStore>,
  dispatch: (profileId: string, slotId: string) => Promise<unknown>,
  candidateDigest?: string,
) {
  verifyCampaign(c);
  const lock = path.join(directory, '.dispatch-lock');
  mkdirSync(lock, { mode: 0o700 });
  try {
    const admittedProfileIds = stores
      .keys()
      .toArray()
      .toSorted((a, b) => a.localeCompare(b));
    const slots = campaignSchedule(
      c,
      kind,
      candidateDigest,
      admittedProfileIds,
    );
    const body = {
      campaignId: c.id,
      kind,
      candidateDigest: candidateDigest ?? null,
      admittedProfileIds,
      slots,
    };
    const plan = { ...body, identity: contentIdentity(body) };
    const file = path.join(directory, `${kind}-schedule.json`);
    try {
      await writeFile(file, `${JSON.stringify(plan)}\n`, {
        flag: 'wx',
        mode: 0o600,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      await owned(file);
      if (
        contentIdentity(JSON.parse(await readFile(file, 'utf8'))) !==
        contentIdentity(plan)
      )
        throw new Error('Frozen stage participants or schedule changed', {
          cause: error,
        });
    }
    for (const planned of slots) {
      const store = stores.get(planned.modelProfileId);
      if (!store) continue; // Roster remains visible as unadmitted.
      if (store.manifest.identity !== planned.experimentIdentity)
        throw new Error('Foreign campaign experiment');
      const state = store.summary();
      if (state.inFlight)
        throw new Error('Unfinished campaign attempt requires reconciliation');
      const observed = state.slots.find((s) => s.slot.id === planned.slotId);
      if (!observed) throw new Error('Missing campaign slot');
      while (store.next()?.slot.id === planned.slotId)
        await dispatch(planned.modelProfileId, planned.slotId);
      if (
        !observed.selected &&
        store.summary().slots.find((s) => s.slot.id === planned.slotId)
          ?.selected === null
      )
        throw new Error('Campaign dispatch did not finish the planned slot');
    }
  } finally {
    rmSync(lock, { recursive: true });
  }
}
export async function executeCampaign(
  file: string,
  kind: BatchKind,
  totalUsd: number,
  count: number,
) {
  if (
    totalUsd !== 100 ||
    !['smoke', 'pilot', 'development', 'sealed', 'confirmation'].includes(kind)
  )
    throw new Error('Explicit global cap and stage required');
  const config = await readConfig(file);
  const campaign = await frozen(config);
  const smokePassed =
    kind === 'smoke'
      ? null
      : await readSmokeAdmission(campaign, config.directory);
  const perModel = {
    smoke: 3,
    pilot: 18,
    development: 102,
    sealed: 54,
    confirmation: 234,
  }[kind];
  if (count !== perModel * campaign.profiles.length)
    throw new Error('Full frozen campaign slot count required');
  const decisions = new Map<
    string,
    { reference: FileReference; value: Decision }
  >();
  async function loadFinalDecisions(): Promise<void> {
    if (kind !== 'sealed' && kind !== 'confirmation') return;
    if (!config.finalDecision)
      throw new Error('A common development-only decision is required');
    const decisionBytes = await pinned(config.finalDecision);
    const d = JSON.parse(decisionBytes.toString()) as {
      campaignId: string;
      decision: 'retain' | 'revise';
      frozenAt: string;
      models: { profileId: string; decision: FileReference }[];
      notAdmittedProfileIds?: string[];
    };
    if (
      d.campaignId !== campaign.id ||
      d.decision !== (kind === 'sealed' ? 'retain' : 'revise') ||
      new Set(d.models.map((m) => m.profileId)).size !== d.models.length ||
      !Number.isFinite(Date.parse(d.frozenAt))
    )
      throw new Error('Common decision differs from campaign');
    for (const profile of validateDecisionRoster(campaign, smokePassed!, d)) {
      const item = d.models.find((m) => m.profileId === profile.id);
      if (!item) throw new Error('Common decision omitted a model');
      const modelDecisionBytes = await pinned(item.decision);
      const value = JSON.parse(modelDecisionBytes.toString()) as Decision;
      if (
        value.decision !== d.decision ||
        Date.parse(value.frozenAt) !== Date.parse(d.frozenAt) ||
        value.developmentIdentity !==
          campaignExperiment(campaign, profile.id, 'development').identity
      )
        throw new Error('Common decision changed a model or cutoff');
      decisions.set(profile.id, { reference: item.decision, value });
    }
  }
  await loadFinalDecisions();
  const preparationLock = path.join(config.directory, '.prepare-lock');
  mkdirSync(preparationLock, { mode: 0o700 });
  try {
    const contexts = new Map<
      string,
      Awaited<ReturnType<typeof prepareFormalExecution>>
    >();
    const admissions: {
      profileId: string;
      status: 'admitted' | 'not_admitted';
      reason: string | null;
    }[] = [];
    const admissionFile = path.join(
      config.directory,
      `${kind}-admissions.json`,
    );
    const prior = existsSync(admissionFile)
      ? (JSON.parse(readFileSync(admissionFile, 'utf8')) as typeof admissions)
      : null;
    const smokeFile = path.join(config.directory, 'smoke-admissions.json');
    const smokeAdmissions =
      kind !== 'smoke' && existsSync(smokeFile)
        ? (JSON.parse(readFileSync(smokeFile, 'utf8')) as typeof admissions)
        : [];
    async function admitProfile(
      profile: (typeof campaign.profiles)[number],
    ): Promise<void> {
      if (smokePassed && !smokePassed.has(profile.id)) {
        admissions.push({
          profileId: profile.id,
          status: 'not_admitted',
          reason: 'smoke_not_passed',
        });
        return;
      }
      const unadmitted = smokeAdmissions.find(
        (a) => a.profileId === profile.id && a.status === 'not_admitted',
      );
      if (unadmitted) {
        admissions.push(unadmitted);
        return;
      }
      if (
        prior?.find((a) => a.profileId === profile.id)?.status ===
        'not_admitted'
      ) {
        admissions.push(prior.find((a) => a.profileId === profile.id)!);
        return;
      }
      try {
        const context = await prepareFormalExecution(
          kind,
          config.admission.file,
          100,
          perModel,
          {
            campaign,
            profileId: profile.id,
            ...(decisions.has(profile.id) && {
              decision: decisions.get(profile.id)!,
            }),
          },
        );
        contexts.set(profile.id, context);
        admissions.push({
          profileId: profile.id,
          status: 'admitted',
          reason: null,
        });
      } catch (error) {
        if (
          kind !== 'smoke' ||
          prior?.some(
            (a) => a.profileId === profile.id && a.status === 'admitted',
          )
        )
          throw error;
        admissions.push({
          profileId: profile.id,
          status: 'not_admitted',
          reason: 'preflight_or_task_admission_failed',
        });
      }
    }
    for (const profile of campaign.profiles) await admitProfile(profile);
    if (!prior)
      await writeFile(admissionFile, `${JSON.stringify(admissions)}\n`, {
        flag: 'wx',
        mode: 0o600,
      });
    const candidate = decisions.values().next().value?.value.candidate?.digest;
    if (decisions.values().some((d) => d.value.candidate?.digest !== candidate))
      throw new Error('Candidate Skill differs between models');
    await runCampaignSchedule(
      campaign,
      kind,
      config.directory,
      new Map([...contexts].map(([id, x]) => [id, x.store])),
      async (id, slot) => contexts.get(id)!.dispatchNext(slot),
      candidate,
    );
    if (kind === 'smoke') {
      const completion = await writeSmokeCompletion(
        campaign,
        config.directory,
        new Map([...contexts].map(([id, x]) => [id, x.store])),
      );
      const passed = await readSmokeAdmission(campaign, config.directory);
      for (const admission of admissions) {
        if (
          admission.status !== 'admitted' ||
          passed.has(admission.profileId)
        ) {
          continue;
        }

        admission.status = 'not_admitted';
        admission.reason = 'smoke_not_passed';
      }
      if (completion.campaignId !== campaign.id)
        throw new Error('Smoke campaign changed');
    }
    return {
      campaignId: campaign.id,
      stage: kind,
      planned: count,
      admissions,
      recordedAttempts: contexts
        .values()
        .reduce((n, c) => n + c.store.summary().attempts.length, 0),
    };
  } finally {
    rmSync(preparationLock, { recursive: true });
  }
}
