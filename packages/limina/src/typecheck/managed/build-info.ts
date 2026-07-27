import {
  type MutationBoundarySnapshot,
  type MutationBoundaryTarget,
  preflightMutationBoundary,
  recheckMutationBoundary,
} from '#utils/mutation-boundary';
import { normalizeAbsolutePath } from '#utils/path';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import {
  ManagedCheckerEmitBoundaryError,
  type ProvenManagedCheckerMutationContext,
} from './types';

function hasMissingOutput(outputPaths: readonly string[]): boolean {
  return outputPaths.some((outputPath) => !existsSync(outputPath));
}

function findBuildInfoBoundaryTarget(options: {
  buildInfoPath: string;
  proof: ProvenManagedCheckerMutationContext;
}): MutationBoundaryTarget {
  const boundaryTarget = options.proof.mutationTargets.find((target) => {
    if (target.kind !== 'file') return false;
    return normalizeAbsolutePath(target.path) === options.buildInfoPath;
  });
  if (boundaryTarget !== undefined) return boundaryTarget;
  throw new ManagedCheckerEmitBoundaryError(
    `Managed checker build info has no authenticated mutation target: ${options.buildInfoPath}.`,
  );
}

function isStaleBuildInfo(options: {
  buildInfoPath: string;
  outputPaths: readonly string[];
}): boolean {
  if (!existsSync(options.buildInfoPath)) return false;
  return hasMissingOutput(options.outputPaths);
}

function getStaleBuildInfoPath(
  buildState: ProvenManagedCheckerMutationContext['buildStateProofs'][number],
): string | undefined {
  const buildInfoPath = buildState.tsBuildInfoPath;
  if (buildInfoPath === undefined) return undefined;
  return isStaleBuildInfo({
    buildInfoPath,
    outputPaths: buildState.outputPaths,
  })
    ? buildInfoPath
    : undefined;
}

function addStaleBuildInfoTargets(
  proof: ProvenManagedCheckerMutationContext,
  targetsByPath: Map<string, MutationBoundaryTarget>,
): void {
  for (const buildState of proof.buildStateProofs) {
    const buildInfoPath = getStaleBuildInfoPath(buildState);
    if (buildInfoPath === undefined) continue;
    targetsByPath.set(
      buildInfoPath,
      findBuildInfoBoundaryTarget({ buildInfoPath, proof }),
    );
  }
}

function collectStaleBuildInfoTargets(
  proofs: readonly ProvenManagedCheckerMutationContext[],
): MutationBoundaryTarget[] {
  const targetsByPath = new Map<string, MutationBoundaryTarget>();
  for (const proof of proofs) {
    addStaleBuildInfoTargets(proof, targetsByPath);
  }
  return [...targetsByPath.values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
}

async function captureTargetSnapshots(
  targets: readonly MutationBoundaryTarget[],
): Promise<Map<string, MutationBoundarySnapshot>> {
  const snapshots = new Map<string, MutationBoundarySnapshot>();
  for (const target of targets) {
    snapshots.set(target.path, await preflightMutationBoundary([target]));
  }
  return snapshots;
}

async function removeStaleTarget(options: {
  snapshot: MutationBoundarySnapshot;
  target: MutationBoundaryTarget;
}): Promise<void> {
  await recheckMutationBoundary(options.snapshot);
  await rm(options.target.path, { force: true });
}

function requireTargetSnapshot(
  target: MutationBoundaryTarget,
  snapshots: ReadonlyMap<string, MutationBoundarySnapshot>,
): MutationBoundarySnapshot {
  const snapshot = snapshots.get(target.path);
  if (snapshot !== undefined) return snapshot;
  throw new ManagedCheckerEmitBoundaryError(
    `Managed checker build info snapshot disappeared: ${target.path}.`,
  );
}

async function removeStaleTargets(
  targets: readonly MutationBoundaryTarget[],
  snapshots: ReadonlyMap<string, MutationBoundarySnapshot>,
): Promise<void> {
  for (const target of targets) {
    await removeStaleTarget({
      snapshot: requireTargetSnapshot(target, snapshots),
      target,
    });
  }
}

export async function invalidateStaleBuildInfo(
  proofs: readonly ProvenManagedCheckerMutationContext[],
): Promise<void> {
  const staleTargets = collectStaleBuildInfoTargets(proofs);
  if (staleTargets.length === 0) return;
  await preflightMutationBoundary(staleTargets);
  await removeStaleTargets(
    staleTargets,
    await captureTargetSnapshots(staleTargets),
  );
}
