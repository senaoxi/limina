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
  readonly changes: readonly ArtifactChange[];
  readonly ownedPaths: readonly string[];
}

export function createArtifactPlan(
  changes: readonly ArtifactChange[],
  ownedPaths: readonly string[],
): ArtifactPlan {
  return Object.freeze({
    changes: Object.freeze(
      [...changes].sort((left, right) => {
        const leftPath =
          left.status === 'delete' ? left.path : left.artifact.path;
        const rightPath =
          right.status === 'delete' ? right.path : right.artifact.path;
        return leftPath.localeCompare(rightPath);
      }),
    ),
    ownedPaths: Object.freeze([...ownedPaths].sort()),
  });
}

export function serializeArtifactPlan(plan: ArtifactPlan): string {
  return `${JSON.stringify(plan, null, 2)}\n`;
}
