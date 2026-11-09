import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { buildCampaignReport } from '../core/campaign-report.ts';
import { campaignFixture } from '../core/campaign.test-helper.ts';
import { campaignExperiment, createCampaign } from '../core/campaign.ts';
import { apiPricingIdentity } from '../core/estimated-cost.ts';
import { contentIdentity } from '../core/identity.ts';
import { RunStore } from '../core/run-store.ts';
import { sha256 } from '../core/snapshot.ts';
import {
  campaignReportInputs,
  type CampaignSourceIndex,
  reanalyseCampaignReport,
  writeCampaignReport,
} from './campaign-report.ts';
import { publicCampaign, readCampaignPublication } from './publication.ts';
import { bindRunBudget } from './run-budget.ts';

test('campaign public projection retains missing models and omits private injected fields', () => {
  const { campaign: c, fixed } = campaignFixture();
  const original = buildCampaignReport(c, 'development', [], fixed);
  const { identity: _index, ...body } = original;
  const report = {
    ...body,
    privateEvidence: '/fictional/hidden',
    identity: contentIdentity({
      ...body,
      privateEvidence: '/fictional/hidden',
    }),
  };
  const publicData = publicCampaign(report);
  assert.equal(publicData.models.length, 3);
  assert.ok(publicData.models.every((m) => m.status === 'missing'));
  assert.ok(publicData.models.every((m) => m.planned === 102));
  const declined = buildCampaignReport(c, 'development', [], fixed, undefined, [
    c.profiles[0]!.id,
  ]);
  assert.equal(publicCampaign(declined).models[0]!.status, 'not_admitted');
  assert.ok(!JSON.stringify(publicData).includes('fictional'));
  const altered = structuredClone(original);
  altered.models[0]!.profile.displayName = '/fictional/private-label';
  const { identity: _id, ...b } = altered;
  altered.identity = contentIdentity(b);
  assert.throws(() => publicCampaign(altered), /profile/);
});

test('bound publication readers retain v1, v2 and v2.1 bank identities', async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'eval-bank-readers-'));
  const root = await realpath(temporary);
  t.after(() => rm(root, { recursive: true, force: true }));
  const adapter = new URL(
    '../../../../scripts/docs/export-evals-campaign.ts',
    import.meta.url,
  ).href;
  const invocation =
    'const {readCampaignPublication}=await import(process.argv[1]);process.stdout.write(JSON.stringify(await readCampaignPublication(process.argv[2],process.argv[3])));';
  const bankIds = new Set<string>();
  for (const revision of ['v1', 'v2', 'v2.1'] as const) {
    const directory = path.join(root, revision);
    await mkdir(directory);
    const { campaign } = campaignFixture(revision);
    const anchor = {
      ledger: path.join(directory, 'budget.jsonl'),
      prefixBytes: 0,
      prefixSha256: sha256(''),
    };
    const {
      id: _id,
      version: _version,
      commonContractId: _common,
      orderingVersion: _order,
      ...input
    } = campaign;
    const frozen = createCampaign({
      ...input,
      budgetAnchorId: contentIdentity(anchor),
    });
    await writeFile(anchor.ledger, '');
    await writeFile(
      path.join(directory, 'budget-anchor.json'),
      JSON.stringify(anchor),
    );
    const campaignFile = path.join(directory, 'campaign.json');
    await writeFile(campaignFile, JSON.stringify(frozen));
    const output = path.join(directory, 'report');
    const result = await writeCampaignReport(
      campaignFile,
      'development',
      [],
      output,
    );
    const data = await readCampaignPublication(
      output,
      result.sourceIndexSha256,
    );
    assert.equal(data.bankRevision, revision);
    assert.equal(data.bankId, campaign.bank.id);
    bankIds.add(data.bankId);
    const child = await promisify(execFile)(process.execPath, [
      '--input-type=module',
      '-e',
      invocation,
      adapter,
      output,
      result.sourceIndexSha256,
    ]);
    assert.deepEqual(JSON.parse(child.stdout), data);
  }
  assert.equal(bankIds.size, 3);
});

test('publication is bound to campaign, raw journal, budget prefix and calculation before projection', async (t) => {
  const temporary = await mkdtemp(
    path.join(tmpdir(), 'eval-bound-publication-'),
  );
  const root = await realpath(temporary);
  t.after(() => rm(root, { recursive: true, force: true }));
  const { campaign: original } = campaignFixture();
  const anchor = {
    ledger: path.join(root, 'budget.jsonl'),
    prefixBytes: 0,
    prefixSha256: sha256(''),
  };
  const {
    id: _campaign,
    version: _version,
    commonContractId: _contract,
    orderingVersion: _order,
    ...input
  } = original;
  const c = createCampaign({
    ...input,
    budgetAnchorId: contentIdentity(anchor),
  });
  await writeFile(
    path.join(root, 'budget-anchor.json'),
    JSON.stringify(anchor),
  );
  const campaignFile = path.join(root, 'campaign.json');
  await writeFile(campaignFile, JSON.stringify(c));
  const budgetFile = path.join(root, 'budget.jsonl');
  await writeFile(budgetFile, '');
  const profile = c.profiles[0]!;
  const store = new RunStore(
    path.join(root, 'run'),
    campaignExperiment(c, profile.id, 'smoke'),
  );
  await writeFile(path.join(store.directory, 'attempts.jsonl'), '');
  await bindRunBudget(store, budgetFile);
  store.startNext();
  const admissionFile = path.join(root, 'smoke-admissions.json');
  await writeFile(
    admissionFile,
    JSON.stringify(
      c.profiles.map((p) => ({
        profileId: p.id,
        status: p.id === profile.id ? 'admitted' : 'not_admitted',
      })),
    ),
  );
  const output = path.join(root, 'report');
  const result = await writeCampaignReport(
    campaignFile,
    'smoke',
    [{ profileId: profile.id, directory: store.directory, budgetFile }],
    output,
  );
  const data = await readCampaignPublication(output, result.sourceIndexSha256);
  assert.equal(data.models.filter((m) => m.report !== null).length, 1);
  const adapter = new URL(
    '../../../../scripts/docs/export-evals-campaign.ts',
    import.meta.url,
  ).href;
  const invocation =
    'const {readCampaignPublication} = await import(process.argv[1]);process.stdout.write(JSON.stringify(await readCampaignPublication(process.argv[2],process.argv[3])));';
  const resultJson = await promisify(execFile)(process.execPath, [
    '--input-type=module',
    '-e',
    invocation,
    adapter,
    output,
    result.sourceIndexSha256,
  ]);
  assert.deepEqual(JSON.parse(resultJson.stdout), data);
  // Exercise the real root publisher in a disposable checkout, never the site's real results.
  const repo = fileURLToPath(new URL('../../../../', import.meta.url));
  const publisherRoot = path.join(root, 'publisher');
  const publisherDirectory = path.join(publisherRoot, 'scripts', 'docs');
  const publicRoot = path.join(
    publisherRoot,
    'docs',
    '.vitepress',
    'theme',
    'evals-campaigns',
  );
  await mkdir(publisherDirectory, { recursive: true });
  await mkdir(publicRoot, { recursive: true });
  await mkdir(path.join(publisherRoot, 'packages'));
  await writeFile(
    path.join(publisherRoot, 'package.json'),
    '{"type":"module"}',
  );
  await symlink(
    path.join(repo, 'packages', 'evals'),
    path.join(publisherRoot, 'packages', 'evals'),
    'dir',
  );
  await symlink(
    path.join(repo, 'node_modules'),
    path.join(publisherRoot, 'node_modules'),
    'dir',
  );
  const publisher = path.join(publisherDirectory, 'export-evals-campaign.ts');
  await copyFile(fileURLToPath(adapter), publisher);
  const publicIndex = path.join(publicRoot, '../evals-campaigns.json');
  await writeFile(publicIndex, '{"schemaVersion":2,"campaigns":[]}');
  const publishInvocation =
    'const {exportCampaign}=await import(process.argv[1]);await exportCampaign(process.argv[2],process.argv[3],process.argv[4]);';
  const publish = (
    reportDirectory: string,
    indexHash: string,
    reportId: string,
  ) =>
    promisify(execFile)(process.execPath, [
      '--input-type=module',
      '-e',
      publishInvocation,
      pathToFileURL(publisher).href,
      reportDirectory,
      indexHash,
      path.join(publicRoot, `${c.id}-smoke-${reportId}.json`),
    ]);
  await publish(output, result.sourceIndexSha256, result.reportIdentity);
  await publish(output, result.sourceIndexSha256, result.reportIdentity);
  const later = path.join(root, 'later-report');
  const laterResult = await writeCampaignReport(
    campaignFile,
    'smoke',
    [{ profileId: profile.id, directory: store.directory, budgetFile }],
    later,
  );
  assert.notEqual(laterResult.reportIdentity, result.reportIdentity);
  await publish(
    later,
    laterResult.sourceIndexSha256,
    laterResult.reportIdentity,
  );
  assert.equal(
    JSON.parse(await readFile(publicIndex, 'utf8')).campaigns.length,
    2,
  );
  const firstSnapshot = path.join(
    publicRoot,
    `${c.id}-smoke-${result.reportIdentity}.json`,
  );
  const originalSnapshot = await readFile(firstSnapshot);
  await writeFile(firstSnapshot, 'edited');
  await assert.rejects(
    publish(output, result.sourceIndexSha256, result.reportIdentity),
  );
  await writeFile(firstSnapshot, originalSnapshot);

  // Reanalyse an archived calculator's frozen prefixes, without trusting its
  // report merely because the caller supplies a correct byte hash.
  const legacyDirectory = path.join(root, 'legacy-report');
  await mkdir(legacyDirectory);
  const indexFile = path.join(output, 'source-index.json');
  const current = JSON.parse(
    await readFile(indexFile, 'utf8'),
  ) as CampaignSourceIndex;
  const {
    identity: _identity,
    reportSha256: _reportHash,
    measurementVersion: _measurements,
    ...legacyBody
  } = current;
  legacyBody.calculationDigest = contentIdentity('archived calculator');
  const legacyIdentity = contentIdentity(legacyBody);
  const legacyReport = buildCampaignReport(
    c,
    'smoke',
    await campaignReportInputs(c, legacyBody),
    legacyIdentity,
    undefined,
    c.profiles.slice(1).map((p) => p.id),
  );
  const legacyReportBytes = JSON.stringify(legacyReport);
  const legacyIndex = {
    ...legacyBody,
    identity: legacyIdentity,
    reportSha256: sha256(legacyReportBytes),
  };
  const legacyIndexBytes = JSON.stringify(legacyIndex);
  await writeFile(path.join(legacyDirectory, 'report.json'), legacyReportBytes);
  await writeFile(
    path.join(legacyDirectory, 'source-index.json'),
    legacyIndexBytes,
  );
  await assert.rejects(
    readCampaignPublication(legacyDirectory, sha256(legacyIndexBytes)),
    /Calculation source/,
  );
  const reanalysedDirectory = path.join(root, 'reanalysed');
  await assert.rejects(
    reanalyseCampaignReport(
      legacyDirectory,
      sha256('wrong'),
      reanalysedDirectory,
    ),
    /integrity/,
  );
  const recalculated = await reanalyseCampaignReport(
    legacyDirectory,
    sha256(legacyIndexBytes),
    reanalysedDirectory,
  );
  const measured = await readCampaignPublication(
    reanalysedDirectory,
    recalculated.sourceIndexSha256,
  );
  assert.equal(
    measured.models[0]!.report!.measurements!.main.all.agentMs.mean,
    null,
  );
  assert.equal(
    measured.models[0]!.report!.measurements!.main.all.apiEquivalentUsd.total,
    null,
  );
  assert.equal(measured.models[1]!.report, null);
  assert.equal(
    await readFile(path.join(legacyDirectory, 'report.json'), 'utf8'),
    legacyReportBytes,
  );
  assert.equal(
    await readFile(path.join(legacyDirectory, 'source-index.json'), 'utf8'),
    legacyIndexBytes,
  );

  // A price-table update must first reproduce already-measured historical
  // reports at their original rates, then attach the current rates separately.
  const pricedDirectory = path.join(root, 'historical-priced-report');
  await mkdir(pricedDirectory);
  const {
    identity: _currentId,
    reportSha256: _currentHash,
    ...pricedBody
  } = current;
  pricedBody.calculationDigest = contentIdentity(
    'archived Terra-only calculator',
  );
  const pricedIdentity = contentIdentity(pricedBody);
  const pricedReport = buildCampaignReport(
    c,
    'smoke',
    await campaignReportInputs(
      c,
      pricedBody,
      '2cd329737e95f450ecd7b12a44c39f2ea895c143b0a249c9a3e6d2c014412d85',
    ),
    pricedIdentity,
    undefined,
    c.profiles.slice(1).map((p) => p.id),
  );
  const pricedBytes = JSON.stringify(pricedReport);
  const pricedIndexBytes = JSON.stringify({
    ...pricedBody,
    identity: pricedIdentity,
    reportSha256: sha256(pricedBytes),
  });
  await writeFile(path.join(pricedDirectory, 'report.json'), pricedBytes);
  await writeFile(
    path.join(pricedDirectory, 'source-index.json'),
    pricedIndexBytes,
  );
  const repricedDirectory = path.join(root, 'repriced-report');
  const repriced = await reanalyseCampaignReport(
    pricedDirectory,
    sha256(pricedIndexBytes),
    repricedDirectory,
  );
  const repricedPublic = await readCampaignPublication(
    repricedDirectory,
    repriced.sourceIndexSha256,
  );
  assert.equal(
    repricedPublic.models[0]!.report!.measurements!.pricing.identity,
    apiPricingIdentity,
  );
  assert.deepEqual(
    repricedPublic.models[0]!.report!.counts,
    measured.models[0]!.report!.counts,
  );
  assert.equal(
    await readFile(path.join(pricedDirectory, 'report.json'), 'utf8'),
    pricedBytes,
  );
  assert.equal(
    await readFile(path.join(pricedDirectory, 'source-index.json'), 'utf8'),
    pricedIndexBytes,
  );
  assert.notEqual(repriced.reportIdentity, pricedReport.identity);
  const forgedPrice = structuredClone(pricedReport);
  forgedPrice.models[0]!.report!.measurements!.main.all.apiEquivalentUsd.mean = 99;
  const { identity: _priceId, ...forgedPriceBody } = forgedPrice;
  forgedPrice.identity = contentIdentity(forgedPriceBody);
  const forgedPriceBytes = JSON.stringify(forgedPrice);
  const forgedPriceIndex = JSON.stringify({
    ...pricedBody,
    identity: pricedIdentity,
    reportSha256: sha256(forgedPriceBytes),
  });
  await writeFile(path.join(pricedDirectory, 'report.json'), forgedPriceBytes);
  await writeFile(
    path.join(pricedDirectory, 'source-index.json'),
    forgedPriceIndex,
  );
  await assert.rejects(
    reanalyseCampaignReport(
      pricedDirectory,
      sha256(forgedPriceIndex),
      path.join(root, 'forged-price-output'),
    ),
    /does not match bound attempts/,
  );

  const privateReport = JSON.parse(
    await readFile(path.join(reanalysedDirectory, 'report.json'), 'utf8'),
  );
  privateReport.models[0].report.measurements.costs.push({
    privatePath: '/fictional/private-cost',
  });
  privateReport.models[0].report.measurements.main.all.agentMs.privateTrace =
    '/fictional/trace';
  const { identity: _privateId, ...privateBody } = privateReport;
  privateReport.identity = contentIdentity(privateBody);
  assert.ok(
    !JSON.stringify(publicCampaign(privateReport)).includes('/fictional/'),
  );
  // Even a re-signed, hash-pinned historical report cannot invent a grade.
  legacyReport.models[0]!.report!.macro.base = 1;
  const { identity: _legacyId, ...changedBody } = legacyReport;
  legacyReport.identity = contentIdentity(changedBody);
  const changedReport = JSON.stringify(legacyReport);
  legacyIndex.reportSha256 = sha256(changedReport);
  const changedIndex = JSON.stringify(legacyIndex);
  await writeFile(path.join(legacyDirectory, 'report.json'), changedReport);
  await writeFile(
    path.join(legacyDirectory, 'source-index.json'),
    changedIndex,
  );
  await assert.rejects(
    reanalyseCampaignReport(
      legacyDirectory,
      sha256(changedIndex),
      path.join(root, 'forged-reanalysis'),
    ),
    /does not match bound attempts/,
  );

  assert.equal(
    data.models.filter((m) => m.status === 'not_admitted').length,
    2,
  );
  const admissionBytes = await readFile(admissionFile);
  await writeFile(admissionFile, '[]');
  await assert.rejects(
    readCampaignPublication(output, result.sourceIndexSha256),
    /Admission source/,
  );
  await writeFile(admissionFile, admissionBytes);
  assert.equal(
    data.models.find((m) => m.report)?.report?.tasks[0]?.conditions.base
      ?.planned,
    1,
  );
  const journal = path.join(store.directory, 'attempts.jsonl');
  const journalBytes = await readFile(journal);
  await writeFile(journal, '{"runId":"another-task"}\n');
  await assert.rejects(
    readCampaignPublication(output, result.sourceIndexSha256),
    /journal prefix changed/,
  );
  await writeFile(
    journal,
    Buffer.concat([journalBytes, Buffer.from('later append\n')]),
  );
  await readCampaignPublication(output, result.sourceIndexSha256);
  await writeFile(journal, journalBytes);
  await writeFile(
    path.join(store.directory, 'attributions.jsonl'),
    'future adjudication\n',
  );
  await readCampaignPublication(output, result.sourceIndexSha256);
  const reportFile = path.join(output, 'report.json');
  const bytes = await readFile(reportFile);
  const report = JSON.parse(bytes.toString());
  report.models[0].profile.canonicalModelId = 'another-model';
  await writeFile(reportFile, JSON.stringify(report));
  await assert.rejects(
    readCampaignPublication(output, result.sourceIndexSha256),
  );
  await writeFile(reportFile, bytes);
  await writeFile(
    budgetFile,
    'later global changes do not alter a frozen report\n',
  );
  await readCampaignPublication(output, result.sourceIndexSha256);
  await writeFile(
    path.join(output, 'ledger-snapshot.jsonl'),
    'tampered snapshot\n',
  );
  await assert.rejects(
    readCampaignPublication(output, result.sourceIndexSha256),
  );
});
