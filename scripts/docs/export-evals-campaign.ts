import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { format } from 'prettier';

const execute = promisify(execFile);
interface PublicationHeader {
  schemaVersion: 2;
  models: unknown[];
  campaignId: string;
  reportIdentity: string;
  bankId: string;
  bankRevision: 'v1' | 'v2' | 'v2.1' | 'v2.2';
  stage: 'smoke' | 'pilot' | 'development' | 'sealed' | 'confirmation';
}
/**
Read-only process boundary: Evals owns private verification and public projection.
*/
export async function readCampaignPublication(
  directory: string,
  expectedIndexHash: string,
) {
  assert.match(expectedIndexHash, /^[a-f\d]{64}$/);
  const cli = fileURLToPath(
    new URL('../../packages/evals/src/cli.ts', import.meta.url),
  );
  const result = await execute(
    process.execPath,
    [
      cli,
      'public-report',
      '--directory',
      directory,
      '--source-index-sha256',
      expectedIndexHash,
    ],
    { maxBuffer: 16 * 1024 * 1024, timeout: 60_000 },
  );
  const data = JSON.parse(result.stdout) as PublicationHeader;
  assert.equal(data.schemaVersion, 2);
  assert.ok(Array.isArray(data.models));
  assert.match(data.campaignId, /^[a-f\d]{64}$/);
  assert.match(data.reportIdentity, /^[a-f\d]{64}$/);
  assert.match(data.bankId, /^[a-f\d]{64}$/);
  assert.ok(['v1', 'v2', 'v2.1', 'v2.2'].includes(data.bankRevision));
  assert.ok(
    ['smoke', 'pilot', 'development', 'sealed', 'confirmation'].includes(
      data.stage,
    ),
  );
  return data;
}
export async function exportCampaign(
  directory: string,
  expectedIndexHash: string,
  output: string,
) {
  const data = await readCampaignPublication(directory, expectedIndexHash);
  const target = path.resolve(output);
  const publicRoot = fileURLToPath(
    new URL('../../docs/.vitepress/theme/evals-campaigns/', import.meta.url),
  );
  assert.equal(await realpath(path.dirname(target)), path.dirname(target));
  assert.ok(
    target.startsWith(publicRoot) &&
      /^[a-f\d]{64}-(?:smoke|pilot|development|sealed|confirmation)-[a-f\d]{64}\.json$/.test(
        path.basename(target),
      ),
    'Use a new versioned campaign snapshot',
  );
  assert.equal(
    path.basename(target),
    `${data.campaignId}-${data.stage}-${data.reportIdentity}.json`,
  );
  const formatted = await format(JSON.stringify(data), { parser: 'json' });
  try {
    await writeFile(target, formatted, { flag: 'wx' });
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
      (await readFile(target, 'utf8')) !== formatted
    )
      throw error;
  }
  const indexFile = path.join(publicRoot, '../evals-campaigns.json');
  const lock = indexFile + '.lock';
  await mkdir(lock);
  try {
    const list = JSON.parse(await readFile(indexFile, 'utf8')) as {
      schemaVersion: number;
      campaigns: {
        file: string;
        campaignId: string;
        bankId?: string;
        reportIdentity: string;
        bankRevision: string;
        stage: string;
      }[];
    };
    assert.equal(list.schemaVersion, 2);
    const key = './evals-campaigns/' + path.basename(target);
    const entry = {
      file: key,
      campaignId: data.campaignId,
      bankId: data.bankId,
      reportIdentity: data.reportIdentity,
      bankRevision: data.bankRevision,
      stage: data.stage,
    };
    const prior = list.campaigns.find((c) => c.file === key);
    if (prior)
      assert.deepEqual(
        { ...prior, bankId: prior.bankId ?? data.bankId },
        entry,
      );
    else {
      list.campaigns.push(entry);
      const temporary = path.join(lock, 'next.json');
      await writeFile(
        temporary,
        await format(JSON.stringify(list), { parser: 'json' }),
      );
      await rename(temporary, indexFile);
    }
  } finally {
    await rm(lock, { recursive: true });
  }
  return data;
}
