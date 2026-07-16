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
  /** Test-only hook for exercising post-validation races. */
  readonly afterPlanSafetyValidation?: () => Promise<void> | void;
  /** Test-only hook for observing or failing a pending mutation. */
  readonly beforeMutation?: (change: ArtifactChange) => Promise<void> | void;
  readonly metrics?: ArtifactMaterializationMetricsRecorder;
}

/**
 * The only production boundary that applies a generated artifact plan.
 * Planning code must only construct an ArtifactPlan and hand it to the
 * run-scoped preflight materialization capability.
 */
async function applyGeneratedArtifactPlan(
  namespace: LiminaArtifactNamespace,
  plan: ArtifactPlan,
  options: MaterializeGeneratedArtifactPlanOptions,
): Promise<void> {
  assertLiminaArtifactNamespace(namespace);
  assertArtifactPlan(plan);
  if (plan.generationToken !== namespace.generationToken) {
    throw new Error(
      'Artifact plan belongs to a different preflight generation.',
    );
  }

  const orderedChanges = [...plan.changes].sort((left, right) => {
    const leftIsManifest =
      left.status !== 'delete' && left.artifact.kind === 'generated-manifest';
    const rightIsManifest =
      right.status !== 'delete' && right.artifact.kind === 'generated-manifest';

    if (leftIsManifest !== rightIsManifest) {
      return leftIsManifest ? 1 : -1;
    }

    const leftPath = left.status === 'delete' ? left.path : left.artifact.path;
    const rightPath =
      right.status === 'delete' ? right.path : right.artifact.path;
    return leftPath.localeCompare(rightPath);
  });

  const targetPaths = orderedChanges.map((change) =>
    change.status === 'delete' ? change.path : change.artifact.path,
  );
  for (const targetPath of targetPaths) {
    assertArtifactPathLexicallyContained(namespace, targetPath);
  }
  for (const ownedPath of plan.ownedPaths) {
    const absoluteOwnedPath = resolveArtifactNamespaceRelativePath(
      namespace,
      ownedPath,
    );
    assertArtifactPathLexicallyContained(namespace, absoluteOwnedPath);
  }
  await assertArtifactPlanPathsOperationSafe(namespace, targetPaths, {
    metrics: options.metrics,
  });
  await options.afterPlanSafetyValidation?.();

  for (const change of orderedChanges) {
    if (change.status === 'unchanged') {
      continue;
    }

    if (change.status === 'delete') {
      await assertArtifactPathOperationSafe(namespace, change.path, {
        metrics: options.metrics,
        phase: 'immediate',
        targetKind: 'file',
      });
      await options.beforeMutation?.(change);
      options.metrics?.record({
        kind: 'delete',
        name: 'artifact-mutation',
        provider: 'artifact-materializer',
      });
      await rm(change.path, { force: true });
      continue;
    }

    await ensureArtifactParentDirectory(namespace, change.artifact.path, {
      metrics: options.metrics,
    });
    await assertArtifactPathOperationSafe(namespace, change.artifact.path, {
      metrics: options.metrics,
      phase: 'immediate',
      targetKind: 'file',
    });
    await options.beforeMutation?.(change);
    options.metrics?.record({
      kind: change.status,
      name: 'artifact-mutation',
      provider: 'artifact-materializer',
    });
    await writeFile(change.artifact.path, change.artifact.content);
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
