import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readAttributions } from '../core/attribution.ts';
import { buildCampaignMeasurements } from '../core/campaign-measurements.ts';
import {
  buildCampaignReport,
  type ModelReportInput,
} from '../core/campaign-report.ts';
import {
  campaignExperiment,
  type CampaignManifest,
  verifyCampaign,
} from '../core/campaign.ts';
import {
  apiPricingIdentity,
  resolveApiPricing,
} from '../core/estimated-cost.ts';
import type { BatchKind } from '../core/experiment.ts';
import { contentIdentity } from '../core/identity.ts';
import { RunStore } from '../core/run-store.ts';
import { sha256 } from '../core/snapshot.ts';
import { estimateAttemptCost } from './estimated-cost.ts';
import { verifyBudgetSource } from './run-budget.ts';

export interface CampaignSourceIndex {
  version: 1;
  measurementVersion?: 1 | 2;
  reanalysisOf?: {
    sourceIndexFile: string;
    sourceIndexSha256: string;
    reportSha256: string;
    reportIdentity: string;
    calculationDigest: string;
  };
  campaignFile: string;
  campaignSha256: string;
  stage: BatchKind;
  candidateDigest?: string;
  ledgerSnapshot: { file: string; sha256: string };
  admission?: { file: string; sha256: string } | null;
  runs: {
    profileId: string;
    directory: string;
    manifestSha256: string;
    journalSha256: string;
    journalBytes: number;
    budgetFile: string;
    budgetSha256: string;
    attributionSha256: string | null;
    attributionBytes: number;
  }[];
  calculationDigest: string;
  identity: string;
  reportSha256: string;
}
export async function campaignCalculationDigest() {
  const names = [
    '../core/campaign-report.ts',
    '../core/campaign-measurements.ts',
    '../core/estimated-cost.ts',
    '../core/report.ts',
    '../core/campaign.ts',
    '../core/experiment.ts',
    '../core/model-profile.ts',
    '../core/task-bank.ts',
    '../core/run-store.ts',
    '../core/budget.ts',
    '../core/attribution.ts',
    './run-budget.ts',
    './campaign-report.ts',
    './estimated-cost.ts',
    './publication.ts',
  ];
  return contentIdentity(
    await Promise.all(
      names.map(async (name) => ({
        name,
        sha256: sha256(await readFile(new URL(name, import.meta.url))),
      })),
    ),
  );
}
async function optionalFile(file: string): Promise<Buffer | null> {
  try {
    return await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
export async function verifyCampaignBudget(
  campaign: CampaignManifest,
  campaignFile: string,
  budgetFiles: string[],
  snapshot?: Uint8Array,
): Promise<void> {
  const file = path.join(path.dirname(campaignFile), 'budget-anchor.json');
  const text = await readFile(file, 'utf8');
  const anchor = JSON.parse(text) as {
    ledger: string;
    prefixBytes: number;
    prefixSha256: string;
  };
  if (
    contentIdentity(anchor) !== campaign.budgetAnchorId ||
    budgetFiles.some((f) => f !== anchor.ledger) ||
    (!snapshot && (await realpath(anchor.ledger)) !== anchor.ledger) ||
    !Number.isSafeInteger(anchor.prefixBytes) ||
    anchor.prefixBytes < 0
  )
    throw new Error('Campaign global budget identity differs');
  const bytes = snapshot
    ? Buffer.from(snapshot)
    : await readFile(anchor.ledger);
  if (
    bytes.length < anchor.prefixBytes ||
    sha256(bytes.subarray(0, anchor.prefixBytes)) !== anchor.prefixSha256
  )
    throw new Error('Campaign global budget prefix changed');
}
export async function campaignReportInputs(
  campaign: CampaignManifest,
  index: Pick<
    CampaignSourceIndex,
    'runs' | 'ledgerSnapshot' | 'measurementVersion'
  >,
  pricingIdentity = apiPricingIdentity,
): Promise<ModelReportInput[]> {
  if (
    index.measurementVersion !== undefined &&
    index.measurementVersion !== 1 &&
    index.measurementVersion !== 2
  )
    throw new Error('Unsupported measurement version');
  const ledgerBytes = await readFile(index.ledgerSnapshot.file);
  if (sha256(ledgerBytes) !== index.ledgerSnapshot.sha256)
    throw new Error('Report ledger snapshot changed');
  const inputs = [];
  for (const reference of index.runs) {
    if ((await realpath(reference.directory)) !== reference.directory)
      throw new Error('Aliased campaign run');
    const store = RunStore.openAt(
      reference.directory,
      reference.journalBytes,
      reference.journalSha256,
    );
    if (
      store.manifest.inputs.modelProfile?.id !== reference.profileId ||
      campaign.profiles.every((p) => p.id !== reference.profileId) ||
      sha256(
        await readFile(path.join(reference.directory, 'manifest.json')),
      ) !== reference.manifestSha256 ||
      sha256(ledgerBytes) !== reference.budgetSha256
    )
      throw new Error('Campaign attempt sources changed');
    let attributionText = '';
    if (reference.attributionSha256 !== null) {
      const raw = await readFile(
        path.join(reference.directory, 'attributions.jsonl'),
      );
      const prefix = raw.subarray(0, reference.attributionBytes);
      if (
        raw.length < reference.attributionBytes ||
        sha256(prefix) !== reference.attributionSha256
      )
        throw new Error('Attribution prefix changed');
      attributionText = prefix.toString('utf8');
    }
    const billing = await verifyBudgetSource(
      store,
      reference.budgetFile,
      ledgerBytes,
    );
    if (billing.digest !== reference.budgetSha256)
      throw new Error('Campaign budget source changed');
    const summary = store.summary();
    const measurements =
      index.measurementVersion === undefined
        ? undefined
        : buildCampaignMeasurements(
            store.manifest,
            summary.attempts,
            await Promise.all(
              summary.attempts.map((a) =>
                estimateAttemptCost(reference.directory, a, pricingIdentity),
              ),
            ),
            pricingIdentity,
            index.measurementVersion,
          );
    inputs.push({
      manifest: store.manifest,
      summary,
      budget: billing.budget,
      attributions: readAttributions(store, attributionText).map(
        (entry) => entry.attribution,
      ),
      ...(measurements && { measurements }),
    });
  }
  return inputs;
}
export async function campaignReportAdmissions(
  campaign: CampaignManifest,
  index: Pick<CampaignSourceIndex, 'admission'>,
): Promise<string[]> {
  if (!index.admission) return [];
  const reference = index.admission;
  const bytes = await readFile(reference.file);
  if (
    (await realpath(reference.file)) !== reference.file ||
    sha256(bytes) !== reference.sha256
  )
    throw new Error('Admission source changed');
  const rows = JSON.parse(bytes.toString()) as {
    profileId: string;
    status: string;
  }[];
  if (
    !Array.isArray(rows) ||
    rows.length !== campaign.profiles.length ||
    new Set(rows.map((r) => r.profileId)).size !== rows.length ||
    rows.some(
      (r) =>
        campaign.profiles.every((p) => p.id !== r.profileId) ||
        !['admitted', 'not_admitted'].includes(r.status),
    )
  )
    throw new Error('Admission roster differs from campaign');
  return rows
    .filter((r) => r.status === 'not_admitted')
    .map((r) => r.profileId);
}
export async function writeCampaignReport(
  campaignFile: string,
  stage: BatchKind,
  runs: { profileId: string; directory: string; budgetFile: string }[],
  output: string,
  candidateDigest?: string,
) {
  if (
    !path.isAbsolute(output) ||
    (await realpath(path.dirname(output))) !== path.dirname(output)
  )
    throw new Error('Report output must be a new canonical directory');
  const bytes = await readFile(campaignFile);
  const campaign = JSON.parse(bytes.toString()) as CampaignManifest;
  verifyCampaign(campaign);
  await verifyCampaignBudget(
    campaign,
    campaignFile,
    runs.map((r) => r.budgetFile),
  );
  const anchorFile = path.join(
    path.dirname(campaignFile),
    'budget-anchor.json',
  );
  const anchor = JSON.parse(await readFile(anchorFile, 'utf8')) as {
    ledger: string;
  };
  const frozenLedger = await readFile(anchor.ledger);
  await mkdir(output, { mode: 0o700 });
  const ledgerFile = path.join(output, 'ledger-snapshot.jsonl');
  await writeFile(ledgerFile, frozenLedger, { mode: 0o600, flag: 'wx' });
  const references = [];
  for (const reference of runs) {
    const store = RunStore.open(reference.directory);
    if (
      contentIdentity(store.manifest) !==
      contentIdentity(
        campaignExperiment(
          campaign,
          reference.profileId,
          stage,
          candidateDigest,
        ),
      )
    )
      throw new Error('Report run outside campaign');
    const manifestSha256 = sha256(
      await readFile(path.join(reference.directory, 'manifest.json')),
    );
    const journalBytes =
      (await optionalFile(path.join(reference.directory, 'attempts.jsonl'))) ??
      Buffer.alloc(0);
    const journalSha256 = sha256(journalBytes);
    const attribution = await optionalFile(
      path.join(reference.directory, 'attributions.jsonl'),
    );
    references.push({
      ...reference,
      manifestSha256,
      journalSha256,
      journalBytes: journalBytes.length,
      attributionBytes: attribution?.length ?? 0,
      budgetSha256: sha256(frozenLedger),
      attributionSha256: attribution === null ? null : sha256(attribution),
    });
  }
  const admissionFile = path.join(
    path.dirname(campaignFile),
    `${stage}-admissions.json`,
  );
  const admissionBytes = await optionalFile(admissionFile);
  const admission =
    admissionBytes === null
      ? null
      : { file: admissionFile, sha256: sha256(admissionBytes) };
  const body = {
    version: 1 as const,
    measurementVersion: 2 as const,
    admission,
    campaignFile,
    campaignSha256: sha256(bytes),
    stage,
    ...(candidateDigest && { candidateDigest }),
    runs: references,
    ledgerSnapshot: { file: ledgerFile, sha256: sha256(frozenLedger) },
    calculationDigest: await campaignCalculationDigest(),
  };
  const identity = contentIdentity(body);
  const report = buildCampaignReport(
    campaign,
    stage,
    await campaignReportInputs(campaign, body),
    identity,
    candidateDigest,
    await campaignReportAdmissions(campaign, body),
  );
  const reportBytes = `${JSON.stringify(report, null, 2)}\n`;
  const index = { ...body, identity, reportSha256: sha256(reportBytes) };
  await writeFile(path.join(output, 'report.json'), reportBytes, {
    mode: 0o600,
    flag: 'wx',
  });
  await writeFile(
    path.join(output, 'source-index.json'),
    `${JSON.stringify(index, null, 2)}\n`,
    { mode: 0o600, flag: 'wx' },
  );
  return {
    campaignId: campaign.id,
    reportIdentity: report.identity,
    sourceIndexSha256: sha256(`${JSON.stringify(index, null, 2)}\n`),
  };
}

/**
Reanalyse pinned prefixes offline. Never open a writer or read the live ledger.
*/
export async function reanalyseCampaignReport(
  directory: string,
  expectedIndexHash: string,
  output: string,
) {
  if (
    !/^[a-f\d]{64}$/.test(expectedIndexHash) ||
    !path.isAbsolute(output) ||
    (await realpath(path.dirname(output))) !== path.dirname(output)
  )
    throw new Error(
      'Reanalysis needs a pinned source and a new canonical output',
    );
  const sourceIndexFile = path.join(directory, 'source-index.json');
  const indexBytes = await readFile(sourceIndexFile);
  if (sha256(indexBytes) !== expectedIndexHash)
    throw new Error('Source index integrity differs');
  const source = JSON.parse(indexBytes.toString()) as CampaignSourceIndex;
  const { identity, reportSha256, ...oldBody } = source;
  if (source.version !== 1 || contentIdentity(oldBody) !== identity)
    throw new Error('Source index identity differs');
  const campaignBytes = await readFile(source.campaignFile);
  if (sha256(campaignBytes) !== source.campaignSha256)
    throw new Error('Campaign source changed');
  const campaign = JSON.parse(campaignBytes.toString()) as CampaignManifest;
  verifyCampaign(campaign);
  const ledger = await readFile(source.ledgerSnapshot.file);
  await verifyCampaignBudget(
    campaign,
    source.campaignFile,
    source.runs.map((r) => r.budgetFile),
    ledger,
  );
  const reportBytes = await readFile(path.join(directory, 'report.json'));
  if (sha256(reportBytes) !== reportSha256)
    throw new Error('Source report changed');
  const original = JSON.parse(reportBytes.toString()) as ReturnType<
    typeof buildCampaignReport
  >;
  const notAdmitted = await campaignReportAdmissions(campaign, source);
  const priceIdentities = new Set(
    original.models.flatMap((model) =>
      model.report?.measurements
        ? [model.report.measurements.pricing.identity]
        : [],
    ),
  );
  if (priceIdentities.size > 1)
    throw new Error('Historical report has conflicting pricing identities');
  const sourcePricingIdentity =
    priceIdentities.values().next().value ?? apiPricingIdentity;
  resolveApiPricing(sourcePricingIdentity);
  const inputs = await campaignReportInputs(
    campaign,
    source,
    sourcePricingIdentity,
  );
  // A changed historical calculator is not silently trusted: its frozen result
  // must still reproduce exactly before the new measurements may be attached.
  const replay = buildCampaignReport(
    campaign,
    source.stage,
    inputs,
    identity,
    source.candidateDigest,
    notAdmitted,
  );
  if (contentIdentity(original) !== contentIdentity(replay))
    throw new Error('Historical report does not match bound attempts');
  const measuredInputs =
    sourcePricingIdentity === apiPricingIdentity &&
    source.measurementVersion === 2
      ? inputs
      : await campaignReportInputs(campaign, {
          ...source,
          measurementVersion: 2,
        });
  await mkdir(output, { mode: 0o700 });
  const ledgerFile = path.join(output, 'ledger-snapshot.jsonl');
  await writeFile(ledgerFile, ledger, { flag: 'wx', mode: 0o600 });
  const body = {
    ...oldBody,
    measurementVersion: 2 as const,
    ledgerSnapshot: { file: ledgerFile, sha256: sha256(ledger) },
    calculationDigest: await campaignCalculationDigest(),
    reanalysisOf: {
      sourceIndexFile,
      sourceIndexSha256: expectedIndexHash,
      reportSha256,
      reportIdentity: original.identity,
      calculationDigest: source.calculationDigest,
    },
  };
  const newIdentity = contentIdentity(body);
  const report = buildCampaignReport(
    campaign,
    source.stage,
    measuredInputs,
    newIdentity,
    source.candidateDigest,
    notAdmitted,
  );
  const newReportBytes = `${JSON.stringify(report, null, 2)}\n`;
  const index = {
    ...body,
    identity: newIdentity,
    reportSha256: sha256(newReportBytes),
  };
  const newIndexBytes = `${JSON.stringify(index, null, 2)}\n`;
  await writeFile(path.join(output, 'report.json'), newReportBytes, {
    flag: 'wx',
    mode: 0o600,
  });
  await writeFile(path.join(output, 'source-index.json'), newIndexBytes, {
    flag: 'wx',
    mode: 0o600,
  });
  return {
    campaignId: campaign.id,
    reportIdentity: report.identity,
    sourceIndexSha256: sha256(newIndexBytes),
  };
}
