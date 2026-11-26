import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect } from 'vitest';
import type { AnalysisProfile } from '../../src/application/analysis/observability';

export async function readAnalysisProfile(
  outputDirectory: string,
): Promise<AnalysisProfile> {
  const files = await readdir(outputDirectory);
  expect(files).toHaveLength(1);
  const filename = files[0]!;
  const profile = JSON.parse(
    await readFile(path.join(outputDirectory, filename), 'utf8'),
  ) as AnalysisProfile;
  expect(filename).toBe(`${profile.invocation.id}.json`);
  return profile;
}

export function profileMetric(profile: AnalysisProfile, key: string): number {
  return profile.metrics
    .filter((metric) => metric.key === key)
    .reduce((value, metric) => value + metric.value, 0);
}
