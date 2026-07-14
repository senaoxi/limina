import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'pathe';
import type { ArtifactPlan } from '../../domain/artifacts/plan';

/**
 * The only production boundary that applies a generated artifact plan.
 * Planning code must only construct an ArtifactPlan and hand it to the
 * run-scoped preflight materialization capability.
 */
async function applyGeneratedArtifactPlan(plan: ArtifactPlan): Promise<void> {
  for (const change of plan.changes) {
    if (change.status === 'unchanged') {
      continue;
    }

    if (change.status === 'delete') {
      await rm(change.path, { force: true });
      continue;
    }

    await mkdir(path.dirname(change.artifact.path), { recursive: true });
    await writeFile(change.artifact.path, change.artifact.content);
  }
}

export async function materializeGeneratedArtifactPlan(
  plan: ArtifactPlan,
): Promise<void> {
  await applyGeneratedArtifactPlan(plan);
}

/** @internal Test support for the low-level graph planner. */
