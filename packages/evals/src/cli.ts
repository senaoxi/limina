import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import {
  reanalyseCampaignReport,
  writeCampaignReport,
} from './controller/campaign-report.ts';
import { executeCampaign, freezeCampaign } from './controller/campaign.ts';
import { writeEstimatedCostReport } from './controller/estimated-cost.ts';
import { executeFormal } from './controller/formal.ts';
import {
  foundationPreflight,
  type FoundationPreflightConfig,
} from './controller/preflight.ts';
import { type BuildToolchain, prepareInputs } from './controller/prepare.ts';
import { writeReport } from './controller/report.ts';
import {
  calibrateBank,
  prepareBankV2,
  prepareBankV21,
} from './controller/task-bank.ts';
import { appendAttribution } from './core/attribution.ts';
import type { BatchKind } from './core/experiment.ts';
import { RunStore } from './core/run-store.ts';
import { isBankRevision } from './core/task-bank.ts';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    repository: { type: 'string' },
    directory: { type: 'string' },
    'source-index-sha256': { type: 'string' },
    stage: { type: 'string' },
    bank: { type: 'string' },
    campaign: { type: 'boolean' },
    'source-store': { type: 'string' },
    prompts: { type: 'string' },
    input: { type: 'string' },
    output: { type: 'string' },
    toolchain: { type: 'string' },
    config: { type: 'string' },
    'run-directory': { type: 'string' },
    'additional-run-directory': { type: 'string', multiple: true },
    'estimated-cost-only': { type: 'boolean' },
    'budget-ledger': { type: 'string' },
    'total-budget-usd': { type: 'string' },
    attempts: { type: 'string' },
    batch: { type: 'string' },
  },
});
if (positionals.length !== 1)
  throw new Error('Expected one evaluation command');
if (values.bank !== undefined && !isBankRevision(values.bank))
  throw new Error('Unsupported task bank revision');
if (
  positionals[0] === 'public-report' &&
  values.directory &&
  values['source-index-sha256']
) {
  const { readCampaignPublication } = await import(
    './controller/publication.ts'
  );
  process.stdout.write(
    `${JSON.stringify(await readCampaignPublication(values.directory, values['source-index-sha256']))}\n`,
  );
} else if (positionals[0] === 'campaign' && values.config && values.stage) {
  const result =
    values.stage === 'freeze'
      ? await freezeCampaign(values.config)
      : await executeCampaign(
          values.config,
          values.stage as BatchKind,
          Number(values['total-budget-usd']),
          Number(values.attempts),
        );
  process.stdout.write(`${JSON.stringify(result)}\n`);
} else if (
  positionals[0] === 'prepare-bank' &&
  values['source-store'] &&
  values.output &&
  values.prompts
) {
  if (
    values.bank !== undefined &&
    values.bank !== 'v2' &&
    values.bank !== 'v2.1'
  )
    throw new Error('prepare-bank requires bank v2 or v2.1');
  const prepareBank = values.bank === 'v2.1' ? prepareBankV21 : prepareBankV2;
  process.stdout.write(
    `${JSON.stringify(
      await prepareBank(values['source-store'], values.output, values.prompts),
    )}\n`,
  );
} else if (
  positionals[0] === 'calibrate' &&
  (values.bank === 'v2' || values.bank === 'v2.1') &&
  values.config
) {
  process.stdout.write(
    `${JSON.stringify(await calibrateBank(values.config, values.bank))}\n`,
  );
} else if (
  positionals[0] === 'report' &&
  values.campaign &&
  values.directory &&
  values['source-index-sha256'] &&
  values.output
) {
  process.stdout.write(
    `${JSON.stringify(await reanalyseCampaignReport(values.directory, values['source-index-sha256'], values.output))}\n`,
  );
} else if (positionals[0] === 'report' && values.campaign && values.config) {
  const c = JSON.parse(await readFile(values.config, 'utf8')) as {
    campaignFile: string;
    stage: BatchKind;
    runs: { profileId: string; directory: string; budgetFile: string }[];
    output: string;
    candidateDigest?: string;
  };
  process.stdout.write(
    `${JSON.stringify(
      await writeCampaignReport(
        c.campaignFile,
        c.stage,
        c.runs,
        c.output,
        c.candidateDigest,
      ),
    )}\n`,
  );
} else if (
  positionals[0] === 'attribute' &&
  values['run-directory'] &&
  values.input
) {
  appendAttribution(
    RunStore.open(values['run-directory']),
    JSON.parse(await readFile(values.input, 'utf8')),
  );
  process.stdout.write(`${JSON.stringify({ appended: true })}\n`);
} else if (
  positionals[0] === 'prepare' &&
  values.repository &&
  values.output &&
  values.toolchain
) {
  const toolchain = JSON.parse(
    await readFile(values.toolchain, 'utf8'),
  ) as BuildToolchain;
  const result = await prepareInputs(
    values.repository,
    values.output,
    toolchain,
  );
  process.stdout.write(
    `${JSON.stringify({ identity: result.identity, head: result.repository.head, artifacts: result.artifacts, skillDigest: result.skillDigest })}\n`,
  );
} else if (positionals[0] === 'preflight' && values.config && values.output) {
  const config = JSON.parse(
    await readFile(values.config, 'utf8'),
  ) as FoundationPreflightConfig;
  const result = await foundationPreflight(config, values.output);
  process.stdout.write(
    `${JSON.stringify({ status: result.status, scope: result.scope, formalDispatchAuthorized: result.formalDispatchAuthorized, evidenceDirectory: values.output, checks: result.checks.map(({ id, passed }) => ({ id, passed })) })}\n`,
  );
  if (result.status !== 'passed') process.exitCode = 1;
} else if (
  (positionals[0] === 'smoke' || positionals[0] === 'run') &&
  values.config
) {
  const batch = positionals[0] === 'smoke' ? 'smoke' : values.batch;
  if (
    !batch ||
    (positionals[0] === 'run' &&
      !['development', 'sealed', 'confirmation'].includes(batch)) ||
    (positionals[0] === 'smoke' && values.batch)
  )
    throw new Error('Invalid formal batch');
  const result = await executeFormal(
    batch as BatchKind,
    values.config,
    Number(values['total-budget-usd']),
    Number(values.attempts),
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
} else if (
  positionals[0] === 'report' &&
  values['estimated-cost-only'] &&
  values['run-directory'] &&
  values.output
) {
  const result = await writeEstimatedCostReport(
    [values['run-directory'], ...(values['additional-run-directory'] ?? [])],
    values.output,
  );
  process.stdout.write(
    `${JSON.stringify({ identity: result.identity, pricingIdentity: result.pricingIdentity, ...result.summary, output: values.output })}\n`,
  );
} else if (
  positionals[0] === 'report' &&
  values['run-directory'] &&
  values['budget-ledger'] &&
  values.output
) {
  const result = await writeReport(
    values['run-directory'],
    values['budget-ledger'],
    values.output,
  );
  process.stdout.write(
    `${JSON.stringify({ experimentIdentity: result.experimentIdentity, provisional: result.provisional, plannedSlots: result.plannedSlots, recordedAttempts: result.recordedAttempts, output: values.output })}\n`,
  );
} else
  throw new Error(
    'Expected prepare, preflight, smoke, run, campaign, prepare-bank, calibrate, attribute or report. Formal commands require --config, --total-budget-usd 100 and --attempts <preregistered count>; run also requires --batch.',
  );
