import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AttemptCost } from '../core/campaign-measurements.ts';
import {
  apiPricing,
  apiPricingIdentity,
  estimateTraceCost,
  summarizeCosts,
  type TraceCost,
} from '../core/estimated-cost.ts';
import type { ExperimentManifest } from '../core/experiment.ts';
import { contentIdentity } from '../core/identity.ts';
import { type AttemptRecord, RunStore } from '../core/run-store.ts';
import { assertRelativePath, sha256 } from '../core/snapshot.ts';

export type CostAttempt = AttemptCost;
export async function estimateAttemptCost(
  directory: string,
  attempt: AttemptRecord,
  pricingIdentity = apiPricingIdentity,
): Promise<AttemptCost> {
  const reference = attempt.evidence.find((entry) => entry.kind === 'trace');
  let cost: TraceCost;
  try {
    if (!reference) throw new Error('No captured native trace');
    assertRelativePath(reference.path);
    const file = path.join(directory, reference.path);
    if ((await realpath(file)) !== file)
      throw new Error('Cost trace is a symlink alias');
    const capture = await readFile(file);
    if (sha256(capture) !== reference.sha256)
      throw new Error('Cost trace integrity differs');
    cost = estimateTraceCost(
      JSON.parse(capture.toString('utf8')),
      attempt.usage,
      pricingIdentity,
    );
  } catch (error) {
    cost = {
      observedUsd: 0,
      totalUsd: null,
      pricedRequests: 0,
      unpricedRequests: 1,
      complete: false,
      reason: error instanceof Error ? error.message : 'Unknown cost input',
    };
  }
  return {
    ...cost,
    runId: attempt.runId,
    experimentIdentity: attempt.experimentIdentity,
    taskId: attempt.slot.taskId,
    condition: attempt.slot.condition,
    repetition: attempt.slot.repetition,
    traceSha256: reference?.sha256 ?? null,
  };
}
export async function collectEstimatedCosts(directories: string[]) {
  if (
    directories.length === 0 ||
    new Set(directories).size !== directories.length
  )
    throw new Error('Distinct cost run directories are required');
  const attempts: CostAttempt[] = [];
  const sources: {
    experimentIdentity: string;
    manifestSha256: string;
    journalSha256: string;
  }[] = [];
  for (const directory of directories) {
    if (
      !path.isAbsolute(directory) ||
      (await realpath(directory)) !== directory
    )
      throw new Error('Cost inputs must be canonical controller paths');
    const bytes = await readFile(path.join(directory, 'manifest.json'));
    const manifest = JSON.parse(bytes.toString('utf8')) as ExperimentManifest;
    const source = {
      experimentIdentity: manifest.identity,
      manifestSha256: sha256(bytes),
      journalSha256: sha256(
        await readFile(path.join(directory, 'attempts.jsonl')),
      ),
    };
    const summary = RunStore.open(directory).summary();
    sources.push(source);
    for (const attempt of summary.attempts) {
      if (attempts.some((row) => row.runId === attempt.runId))
        throw new Error('Duplicate cost attempt');
      attempts.push(await estimateAttemptCost(directory, attempt));
    }
    if (
      sha256(await readFile(path.join(directory, 'attempts.jsonl'))) !==
        source.journalSha256 ||
      sha256(await readFile(path.join(directory, 'manifest.json'))) !==
        source.manifestSha256
    )
      throw new Error('Cost inputs changed during collection');
  }
  const calculationIdentity = contentIdentity(
    await Promise.all(
      [
        new URL('../core/estimated-cost.ts', import.meta.url),
        new URL('estimated-cost.ts', import.meta.url),
      ].map(async (file) => sha256(await readFile(file))),
    ),
  );
  const data = {
    version: 1 as const,
    kind: 'api-equivalent-estimate' as const,
    pricing: apiPricing,
    pricingIdentity: apiPricingIdentity,
    calculationIdentity,
    sources,
    attempts,
    summary: summarizeCosts(attempts),
  };
  return { ...data, identity: contentIdentity(data) };
}
export type EstimatedCostReport = Awaited<
  ReturnType<typeof collectEstimatedCosts>
>;
export async function writeEstimatedCostReport(
  directories: string[],
  output: string,
) {
  if (
    !path.isAbsolute(output) ||
    path.resolve(output) !== output ||
    (await realpath(path.dirname(output))) !== path.dirname(output)
  )
    throw new Error('Cost report needs a new canonical output directory');
  const report = await collectEstimatedCosts(directories);
  await mkdir(output, { mode: 0o700 });
  await writeFile(
    path.join(output, 'estimated-cost.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    { flag: 'wx', mode: 0o600 },
  );
  return report;
}
