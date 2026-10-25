import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
import { compareCodeUnits } from '#utils/collections';
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

/**
 * An external source input has no consumer emit obligation, but its type can
 * change without invalidating the compiler's solution-builder timestamp check.
 * Until a separate incremental-input proof exists, rebuild that consumer. This
 * grants no reference, producer, output authority or additional process target.
 */
export function sourceInputConsumers(
  graph: GeneratedTsconfigGraphResult,
): ReadonlySet<string> {
  const consumers = new Set<string>();
  const evidence = graph.dependencyAnalysis?.nativeEvidence ?? [];
  for (const { snapshot } of evidence) {
    const locked = new Set(
      snapshot.contexts
        .filter((context) => context.authority.phase === 'locked')
        .map((context) => context.id),
    );
    for (const obligation of snapshot.obligations) {
      if (
        locked.has(obligation.consumerContextId) &&
        obligation.existence.state === 'absent' &&
        obligation.existence.proof.ruleOrObservation ===
          'compiler-external-library-input-is-not-emitted-by-consumer'
      )
        consumers.add(obligation.consumerConfigId);
    }
  }
  return consumers;
}

function hasMissingOutput(outputPaths: readonly string[]): boolean {
  return outputPaths.some((outputPath) => !existsSync(outputPath));
}

function findBuildInfoBoundaryTarget(options: {
  buildInfoPath: string;
  proof: ProvenManagedCheckerMutationContext;
}): MutationBoundaryTarget {
  const boundaryTarget = options.proof.mutationTargets.find((target) => {
    return (
      target.kind === 'file' &&
      normalizeAbsolutePath(target.path) === options.buildInfoPath
    );
  });
  if (boundaryTarget !== undefined) return boundaryTarget;
  throw new ManagedCheckerEmitBoundaryError(
    `Managed checker build info has no authenticated mutation target: ${options.buildInfoPath}.`,
  );
}

function isStaleBuildInfo(options: {
  buildInfoPath: string;
  outputPaths: readonly string[];
  requiresFullCheck?: boolean;
}): boolean {
  return (
    existsSync(options.buildInfoPath) &&
    (options.requiresFullCheck === true ||
      hasMissingOutput(options.outputPaths))
  );
}

function getStaleBuildInfoPath(
  buildState: ProvenManagedCheckerMutationContext['buildStateProofs'][number],
): string | undefined {
  const buildInfoPath = buildState.tsBuildInfoPath;
  if (buildInfoPath === undefined) return undefined;
  return isStaleBuildInfo({
    buildInfoPath,
    outputPaths: buildState.outputPaths,
    requiresFullCheck: buildState.requiresFullCheck,
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
  return targetsByPath
    .values()
    .toArray()
    .sort((left, right) => compareCodeUnits(left.path, right.path));
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
