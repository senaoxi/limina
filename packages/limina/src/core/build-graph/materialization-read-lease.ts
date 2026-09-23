import {
  assertLiminaArtifactNamespace,
  type LiminaArtifactNamespace,
} from '../../domain/artifacts/namespace';
import {
  type ArtifactPlan,
  assertArtifactPlan,
} from '../../domain/artifacts/plan';
import { readMaterializationStateSnapshot } from './materialization-state';
import { withGeneratedArtifactReadLease } from './materializer';

export async function withMaterializedPlanReadLease<T>(
  namespace: LiminaArtifactNamespace,
  plan: ArtifactPlan,
  operation: () => Promise<T>,
): Promise<T> {
  assertLiminaArtifactNamespace(namespace);
  assertArtifactPlan(plan);
  if (plan.generationToken !== namespace.generationToken) {
    throw new Error(
      'Artifact plan belongs to a different preflight generation.',
    );
  }
  return withGeneratedArtifactReadLease(namespace, async () => {
    const current = await readMaterializationStateSnapshot(namespace);
    if (current.revision !== plan.desiredRevision) {
      throw new Error(
        'Generated-artifact revision changed after materialization; rerun the checker command.',
      );
    }
    return operation();
  });
}
