import type { ArtifactNamespaceGenerationToken } from './namespace';
import {
  assertArtifactPathLexicallyContained,
  assertLiminaArtifactNamespace,
  type LiminaArtifactNamespace,
  toArtifactNamespaceRelativePath,
} from './namespace';

const artifactPlanBrand: unique symbol = Symbol('ArtifactPlan');
const authenticatedArtifactPlans = new WeakSet<object>();

export type ArtifactKind =
  | 'generated-config'
  | 'generated-manifest'
  | 'tool-config';

export interface ArtifactOrigin {
  readonly domain: string;
  readonly generation?: string;
}

export interface GeneratedArtifact {
  readonly content: string | Uint8Array;
  readonly kind: ArtifactKind;
  readonly origin: ArtifactOrigin;
  readonly path: string;
}

export type ArtifactChange =
  | {
      readonly artifact: GeneratedArtifact;
      readonly status: 'create' | 'update';
    }
  | { readonly artifact: GeneratedArtifact; readonly status: 'unchanged' }
  | { readonly path: string; readonly status: 'delete' };

export interface ArtifactPlan {
  readonly [artifactPlanBrand]: true;
  readonly changes: readonly ArtifactChange[];
  readonly generationToken: ArtifactNamespaceGenerationToken;
  readonly ownedPaths: readonly string[];
}

export function createArtifactPlan(
  namespace: LiminaArtifactNamespace,
  changes: readonly ArtifactChange[],
  ownedPaths: readonly string[],
): ArtifactPlan {
  assertLiminaArtifactNamespace(namespace);
  for (const change of changes) {
    assertArtifactPathLexicallyContained(
      namespace,
      change.status === 'delete' ? change.path : change.artifact.path,
    );
  }
  const relativeOwnedPaths = ownedPaths.map((ownedPath) =>
    toArtifactNamespaceRelativePath(namespace, ownedPath),
  );
  const plan = Object.freeze({
    [artifactPlanBrand]: true as const,
    changes: Object.freeze(
      [...changes].sort((left, right) => {
        const leftPath =
          left.status === 'delete' ? left.path : left.artifact.path;
        const rightPath =
          right.status === 'delete' ? right.path : right.artifact.path;
        return leftPath.localeCompare(rightPath);
      }),
    ),
    generationToken: namespace.generationToken,
    ownedPaths: Object.freeze(relativeOwnedPaths.sort()),
  });
  authenticatedArtifactPlans.add(plan);
  return plan;
}

export function assertArtifactPlan(plan: ArtifactPlan): void {
  if (!authenticatedArtifactPlans.has(plan)) {
    throw new Error('Unauthenticated generated artifact plan.');
  }
}
