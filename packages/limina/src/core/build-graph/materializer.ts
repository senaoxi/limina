import { rm, writeFile } from 'node:fs/promises';
import {
  assertArtifactPathLexicallyContained,
  assertArtifactPathOperationSafe,
  assertLiminaArtifactNamespace,
  ensureArtifactParentDirectory,
  type LiminaArtifactNamespace,
  resolveArtifactNamespaceRelativePath,
} from '../../domain/artifacts/namespace';
import {
  type ArtifactPlan,
  assertArtifactPlan,
} from '../../domain/artifacts/plan';

/**
 * The only production boundary that applies a generated artifact plan.
 * Planning code must only construct an ArtifactPlan and hand it to the
 * run-scoped preflight materialization capability.
 */
async function applyGeneratedArtifactPlan(
  namespace: LiminaArtifactNamespace,
  plan: ArtifactPlan,
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

  for (const change of orderedChanges) {
    const targetPath =
      change.status === 'delete' ? change.path : change.artifact.path;
    assertArtifactPathLexicallyContained(namespace, targetPath);
    await assertArtifactPathOperationSafe(namespace, targetPath, {
      targetKind: 'file',
    });
  }
  for (const ownedPath of plan.ownedPaths) {
    const absoluteOwnedPath = resolveArtifactNamespaceRelativePath(
      namespace,
      ownedPath,
    );
    assertArtifactPathLexicallyContained(namespace, absoluteOwnedPath);
  }

  for (const change of orderedChanges) {
    if (change.status === 'unchanged') {
      continue;
    }

    if (change.status === 'delete') {
      await assertArtifactPathOperationSafe(namespace, change.path, {
        targetKind: 'file',
      });
      await rm(change.path, { force: true });
      continue;
    }

    await ensureArtifactParentDirectory(namespace, change.artifact.path);
    await assertArtifactPathOperationSafe(namespace, change.artifact.path, {
      targetKind: 'file',
    });
    await writeFile(change.artifact.path, change.artifact.content);
  }
}

export async function materializeGeneratedArtifactPlan(
  namespace: LiminaArtifactNamespace,
  plan: ArtifactPlan,
): Promise<void> {
  await applyGeneratedArtifactPlan(namespace, plan);
}

/** @internal Test support for the low-level graph planner. */
