import {
  type ArtifactSafetyMetricsRecorder,
  assertLiminaArtifactNamespace,
  type LiminaArtifactNamespace,
  toArtifactNamespaceRelativePath,
} from '../../domain/artifacts/namespace';
import {
  type ArtifactChange,
  type ArtifactPlan,
  assertArtifactPlan,
} from '../../domain/artifacts/plan';
import {
  acquireCrossProcessReadLease,
  acquireCrossProcessWriteLease,
  type CrossProcessLeaseOptions,
} from '../../utils/mutation/cross-process-lease';
import {
  deleteNonTargetOwnedPaths,
  getTargetArtifacts,
  orderArtifactChanges,
  validateArtifactPlanSafety,
  verifyDesiredTree,
  writeTargetArtifacts,
} from './materialization-operations';
import {
  createMaterializationMarker,
  MaterializationRecoveryRequired,
  readMaterializationMarker,
  readMaterializationStateSnapshot,
  removeMaterializationMarker,
  writeMaterializationMarker,
} from './materialization-state';

interface ArtifactMaterializationMetricsRecorder
  extends ArtifactSafetyMetricsRecorder {
  record(measurement: {
    readonly count?: number;
    readonly kind?: string;
    readonly name:
      | 'artifact-mutation'
      | 'artifact-safety-immediate-recheck'
      | 'artifact-safety-lstat'
      | 'artifact-safety-unique-node';
    readonly provider?: string;
  }): void;
}

export interface MaterializeGeneratedArtifactPlanOptions {
  readonly afterPlanSafetyValidation?: () => Promise<void> | void;
  readonly beforeMutation?: (change: ArtifactChange) => Promise<void> | void;
  readonly metrics?: ArtifactMaterializationMetricsRecorder;
  /** Failure injection seam for marker cleanup regression tests. */
  readonly removeMarker?: (namespace: LiminaArtifactNamespace) => Promise<void>;
  readonly replan?: () => Promise<{
    namespace: LiminaArtifactNamespace;
    plan: ArtifactPlan;
  }>;
  readonly lease?: CrossProcessLeaseOptions;
}

function assertMatchingGeneration(
  namespace: LiminaArtifactNamespace,
  plan: ArtifactPlan,
): void {
  if (plan.generationToken !== namespace.generationToken) {
    throw new Error(
      'Artifact plan belongs to a different preflight generation.',
    );
  }
}

function revisionsMatch(
  left: ArtifactPlan['baseRevision'],
  right: ArtifactPlan['baseRevision'],
): boolean {
  return left === right;
}

async function readPlanBaseState(
  namespace: LiminaArtifactNamespace,
  plan: ArtifactPlan,
) {
  if (plan.revisionValidated) {
    return readMaterializationStateSnapshot(namespace);
  }
  return { ownedPaths: [...plan.baseOwnedPaths], revision: plan.baseRevision };
}

function requiresReplan(options: {
  currentRevision: ArtifactPlan['baseRevision'];
  markerPresent: boolean;
  plan: ArtifactPlan;
}): boolean {
  if (options.markerPresent && options.plan.revisionValidated) return true;
  return !revisionsMatch(options.currentRevision, options.plan.baseRevision);
}

function requireReplan(
  replan: MaterializeGeneratedArtifactPlanOptions['replan'],
): NonNullable<MaterializeGeneratedArtifactPlanOptions['replan']> {
  if (replan !== undefined) return replan;
  throw new Error(
    'Generated-artifact base revision changed before materialization.',
  );
}

function assertSameCanonicalRoot(
  original: LiminaArtifactNamespace,
  replanned: LiminaArtifactNamespace,
): void {
  if (replanned.canonicalRootDir === original.canonicalRootDir) return;
  throw new Error(
    'Generated-artifact replan changed the canonical lease root.',
  );
}

function assertReplannedRevision(
  plan: ArtifactPlan,
  currentRevision: ArtifactPlan['baseRevision'],
): void {
  if (revisionsMatch(currentRevision, plan.baseRevision)) return;
  throw new Error(
    'Generated-artifact base revision changed after the single allowed replan.',
  );
}

async function replanOnce(options: {
  namespace: LiminaArtifactNamespace;
  replan: NonNullable<MaterializeGeneratedArtifactPlanOptions['replan']>;
}) {
  const replanned = await options.replan();
  assertSameCanonicalRoot(options.namespace, replanned.namespace);
  const current = await readPlanBaseState(replanned.namespace, replanned.plan);
  assertReplannedRevision(replanned.plan, current.revision);
  return replanned;
}

async function selectValidatedPlan(options: {
  markerPresent: boolean;
  namespace: LiminaArtifactNamespace;
  plan: ArtifactPlan;
  replan?: MaterializeGeneratedArtifactPlanOptions['replan'];
}): Promise<{
  namespace: LiminaArtifactNamespace;
  plan: ArtifactPlan;
  recovered: boolean;
}> {
  const current = await readPlanBaseState(options.namespace, options.plan);
  const needsReplan = requiresReplan({
    currentRevision: current.revision,
    markerPresent: options.markerPresent,
    plan: options.plan,
  });
  if (!needsReplan) {
    return {
      namespace: options.namespace,
      plan: options.plan,
      recovered: options.markerPresent,
    };
  }
  const replanned = await replanOnce({
    namespace: options.namespace,
    replan: requireReplan(options.replan),
  });
  return { ...replanned, recovered: options.markerPresent };
}

async function materializeUnderWriteLease(options: {
  leaseOwner: Awaited<
    ReturnType<typeof acquireCrossProcessWriteLease>
  >['owner'];
  materialization: MaterializeGeneratedArtifactPlanOptions;
  namespace: LiminaArtifactNamespace;
  plan: ArtifactPlan;
}): Promise<{ namespace: LiminaArtifactNamespace; plan: ArtifactPlan }> {
  const oldMarker = await readMaterializationMarker(options.namespace);
  const selected = await selectValidatedPlan({
    markerPresent: oldMarker !== null,
    namespace: options.namespace,
    plan: options.plan,
    replan: options.materialization.replan,
  });
  assertLiminaArtifactNamespace(selected.namespace);
  assertArtifactPlan(selected.plan);
  assertMatchingGeneration(selected.namespace, selected.plan);
  const current = selected.plan.revisionValidated
    ? await readMaterializationStateSnapshot(selected.namespace)
    : {
        ownedPaths: [...selected.plan.baseOwnedPaths],
        revision: selected.plan.baseRevision,
      };
  const orderedChanges = orderArtifactChanges(selected.plan);
  await validateArtifactPlanSafety({
    materialization: options.materialization,
    namespace: selected.namespace,
    orderedChanges,
    plan: selected.plan,
  });
  const marker = createMaterializationMarker({
    baseRevision: selected.plan.baseRevision,
    currentOwnedPaths: current.ownedPaths,
    desiredRevision: selected.plan.desiredRevision,
    oldMarker,
    owner: options.leaseOwner,
    planBaseOwnedPaths: selected.plan.baseOwnedPaths,
    planDeletePaths: selected.plan.changes.flatMap((change) =>
      change.status === 'delete'
        ? [toArtifactNamespaceRelativePath(selected.namespace, change.path)]
        : [],
    ),
    targetOwnedPaths: selected.plan.ownedPaths,
  });
  await writeMaterializationMarker({
    marker,
    namespace: selected.namespace,
  });
  const targetArtifacts = getTargetArtifacts(selected.namespace, selected.plan);
  await writeTargetArtifacts({
    force: selected.recovered,
    manifestOnly: false,
    materialization: options.materialization,
    namespace: selected.namespace,
    plan: selected.plan,
  });
  await deleteNonTargetOwnedPaths({
    materialization: options.materialization,
    namespace: selected.namespace,
    ownedPathUniverse: marker.ownedPathUniverse,
    targetOwnedPaths: new Set(marker.targetOwnedPaths),
  });
  await writeTargetArtifacts({
    force: selected.recovered,
    manifestOnly: true,
    materialization: options.materialization,
    namespace: selected.namespace,
    plan: selected.plan,
  });
  await verifyDesiredTree({
    namespace: selected.namespace,
    plan: selected.plan,
    targetArtifacts,
  });
  await (options.materialization.removeMarker ?? removeMaterializationMarker)(
    selected.namespace,
  );
  return { namespace: selected.namespace, plan: selected.plan };
}

export async function materializeGeneratedArtifactPlan(
  namespace: LiminaArtifactNamespace,
  plan: ArtifactPlan,
  options: MaterializeGeneratedArtifactPlanOptions = {},
): Promise<{ namespace: LiminaArtifactNamespace; plan: ArtifactPlan }> {
  assertLiminaArtifactNamespace(namespace);
  assertArtifactPlan(plan);
  assertMatchingGeneration(namespace, plan);
  const lease = await acquireCrossProcessWriteLease(
    namespace.canonicalRootDir,
    options.lease,
  );
  try {
    return await materializeUnderWriteLease({
      leaseOwner: lease.owner,
      materialization: options,
      namespace,
      plan,
    });
  } finally {
    await lease.release();
  }
}

export async function withGeneratedArtifactReadLease<T>(
  namespace: LiminaArtifactNamespace,
  operation: () => Promise<T>,
  options: CrossProcessLeaseOptions = {},
): Promise<T> {
  const lease = await acquireCrossProcessReadLease(
    namespace.canonicalRootDir,
    options,
  );
  try {
    const marker = await readMaterializationMarker(namespace);
    if (marker !== null) {
      throw new MaterializationRecoveryRequired(
        'Generated-artifact materialization was interrupted; a writer must recover it before readers can continue.',
      );
    }
    return await operation();
  } finally {
    await lease.release();
  }
}
