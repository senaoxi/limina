import { rm, writeFile } from 'node:fs/promises';
import {
  type ArtifactSafetyMetricsRecorder,
  assertArtifactPathLexicallyContained,
  assertArtifactPathOperationSafe,
  assertArtifactPlanPathsOperationSafe,
  assertLiminaArtifactNamespace,
  ensureArtifactParentDirectory,
  type LiminaArtifactNamespace,
  resolveArtifactNamespaceRelativePath,
} from '../../domain/artifacts/namespace';
import {
  type ArtifactChange,
  type ArtifactPlan,
  assertArtifactPlan,
} from '../../domain/artifacts/plan';

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
}

function isGeneratedManifestChange(change: ArtifactChange): boolean {
  return (
    change.status !== 'delete' && change.artifact.kind === 'generated-manifest'
  );
}

function getArtifactChangePath(change: ArtifactChange): string {
  return change.status === 'delete' ? change.path : change.artifact.path;
}

function compareArtifactChanges(
  left: ArtifactChange,
  right: ArtifactChange,
): number {
  const manifestDifference =
    Number(isGeneratedManifestChange(left)) -
    Number(isGeneratedManifestChange(right));

  return manifestDifference === 0
    ? getArtifactChangePath(left).localeCompare(getArtifactChangePath(right))
    : manifestDifference;
}

function orderArtifactChanges(plan: ArtifactPlan): ArtifactChange[] {
  return [...plan.changes].sort(compareArtifactChanges);
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

function assertTargetPathsContained(
  namespace: LiminaArtifactNamespace,
  targetPaths: readonly string[],
): void {
  for (const targetPath of targetPaths) {
    assertArtifactPathLexicallyContained(namespace, targetPath);
  }
}

function assertOwnedPathsContained(
  namespace: LiminaArtifactNamespace,
  ownedPaths: readonly string[],
): void {
  for (const ownedPath of ownedPaths) {
    const absoluteOwnedPath = resolveArtifactNamespaceRelativePath(
      namespace,
      ownedPath,
    );
    assertArtifactPathLexicallyContained(namespace, absoluteOwnedPath);
  }
}

function recordMutation(
  options: MaterializeGeneratedArtifactPlanOptions,
  kind: string,
): void {
  options.metrics?.record({
    kind,
    name: 'artifact-mutation',
    provider: 'artifact-materializer',
  });
}

async function applyDeleteChange(
  namespace: LiminaArtifactNamespace,
  change: Extract<ArtifactChange, { status: 'delete' }>,
  options: MaterializeGeneratedArtifactPlanOptions,
): Promise<void> {
  await assertArtifactPathOperationSafe(namespace, change.path, {
    metrics: options.metrics,
    phase: 'immediate',
    targetKind: 'file',
  });
  await options.beforeMutation?.(change);
  recordMutation(options, 'delete');
  await rm(change.path, { force: true });
}

async function applyWriteChange(
  namespace: LiminaArtifactNamespace,
  change: Exclude<ArtifactChange, { status: 'delete' | 'unchanged' }>,
  options: MaterializeGeneratedArtifactPlanOptions,
): Promise<void> {
  await ensureArtifactParentDirectory(namespace, change.artifact.path, {
    metrics: options.metrics,
  });
  await assertArtifactPathOperationSafe(namespace, change.artifact.path, {
    metrics: options.metrics,
    phase: 'immediate',
    targetKind: 'file',
  });
  await options.beforeMutation?.(change);
  recordMutation(options, change.status);
  await writeFile(change.artifact.path, change.artifact.content);
}

async function applyArtifactChange(
  namespace: LiminaArtifactNamespace,
  change: ArtifactChange,
  options: MaterializeGeneratedArtifactPlanOptions,
): Promise<void> {
  if (change.status === 'unchanged') {
    return;
  }

  if (change.status === 'delete') {
    await applyDeleteChange(namespace, change, options);
    return;
  }

  await applyWriteChange(namespace, change, options);
}

async function validateArtifactPlanSafety(options: {
  materialization: MaterializeGeneratedArtifactPlanOptions;
  namespace: LiminaArtifactNamespace;
  orderedChanges: readonly ArtifactChange[];
  plan: ArtifactPlan;
}): Promise<void> {
  const targetPaths = options.orderedChanges.map(getArtifactChangePath);
  assertTargetPathsContained(options.namespace, targetPaths);
  assertOwnedPathsContained(options.namespace, options.plan.ownedPaths);
  await assertArtifactPlanPathsOperationSafe(options.namespace, targetPaths, {
    metrics: options.materialization.metrics,
  });
  await options.materialization.afterPlanSafetyValidation?.();
}

async function applyGeneratedArtifactPlan(
  namespace: LiminaArtifactNamespace,
  plan: ArtifactPlan,
  options: MaterializeGeneratedArtifactPlanOptions,
): Promise<void> {
  assertLiminaArtifactNamespace(namespace);
  assertArtifactPlan(plan);
  assertMatchingGeneration(namespace, plan);

  const orderedChanges = orderArtifactChanges(plan);
  await validateArtifactPlanSafety({
    materialization: options,
    namespace,
    orderedChanges,
    plan,
  });

  for (const change of orderedChanges) {
    await applyArtifactChange(namespace, change, options);
  }
}

export async function materializeGeneratedArtifactPlan(
  namespace: LiminaArtifactNamespace,
  plan: ArtifactPlan,
  options: MaterializeGeneratedArtifactPlanOptions = {},
): Promise<void> {
  await applyGeneratedArtifactPlan(namespace, plan, options);
}

/** @internal Test support for the low-level graph planner. */
