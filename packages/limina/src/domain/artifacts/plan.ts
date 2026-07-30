import { createHash } from 'node:crypto';
import {
  identifier,
  type MaterializationRevision,
} from '../shared/identifiers';
import type { ArtifactNamespaceGenerationToken } from './namespace-core';
import {
  assertArtifactPathLexicallyContained,
  assertLiminaArtifactNamespace,
  type LiminaArtifactNamespace,
  toArtifactNamespaceRelativePath,
} from './namespace-core';

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
  readonly baseOwnedPaths: readonly string[];
  readonly baseRevision: MaterializationRevision;
  readonly changes: readonly ArtifactChange[];
  readonly generationToken: ArtifactNamespaceGenerationToken;
  readonly ownedPaths: readonly string[];
  readonly desiredRevision: MaterializationRevision;
  /** @internal Whether base revision metadata came from a complete planner snapshot. */
  readonly revisionValidated: boolean;
}

export interface ArtifactPlanRevisionOptions {
  readonly baseOwnedPaths: readonly string[];
  readonly baseRevision: MaterializationRevision;
}

function updateHashContent(
  hash: ReturnType<typeof createHash>,
  content: string | Uint8Array | null,
): void {
  if (content === null) {
    hash.update('missing');
    return;
  }
  hash.update(typeof content === 'string' ? Buffer.from(content) : content);
}

export function createMaterializationRevision(
  entries: readonly {
    content: string | Uint8Array | null;
    path: string;
  }[],
): MaterializationRevision {
  const hash = createHash('sha256');
  for (const entry of [...entries].sort((left, right) =>
    left.path.localeCompare(right.path),
  )) {
    hash.update(entry.path);
    hash.update('\0');
    updateHashContent(hash, entry.content);
    hash.update('\0');
  }
  return identifier<'MaterializationRevision'>(hash.digest('hex'));
}

function createDesiredRevision(
  namespace: LiminaArtifactNamespace,
  changes: readonly ArtifactChange[],
  ownedPaths: readonly string[],
): MaterializationRevision {
  const contentByPath = new Map(
    changes.flatMap((change) =>
      change.status === 'delete'
        ? []
        : [
            [
              toArtifactNamespaceRelativePath(namespace, change.artifact.path),
              change.artifact.content,
            ] as const,
          ],
    ),
  );
  return createMaterializationRevision(
    ownedPaths.map((ownedPath) => ({
      content: contentByPath.get(ownedPath) ?? null,
      path: ownedPath,
    })),
  );
}

function getChangePath(change: ArtifactChange): string {
  return change.status === 'delete' ? change.path : change.artifact.path;
}

function assertChangesContained(
  namespace: LiminaArtifactNamespace,
  changes: readonly ArtifactChange[],
): void {
  for (const change of changes) {
    assertArtifactPathLexicallyContained(namespace, getChangePath(change));
  }
}

function collectDeletedPaths(
  namespace: LiminaArtifactNamespace,
  changes: readonly ArtifactChange[],
): Set<string> {
  return new Set(
    changes.flatMap((change) =>
      change.status === 'delete'
        ? [toArtifactNamespaceRelativePath(namespace, change.path)]
        : [],
    ),
  );
}

function normalizeOwnedPaths(options: {
  deletedPaths: ReadonlySet<string>;
  namespace: LiminaArtifactNamespace;
  ownedPaths: readonly string[];
}): string[] {
  return options.ownedPaths
    .map((ownedPath) =>
      toArtifactNamespaceRelativePath(options.namespace, ownedPath),
    )
    .filter((ownedPath) => !options.deletedPaths.has(ownedPath))
    .sort();
}

function normalizeBaseOwnedPaths(
  namespace: LiminaArtifactNamespace,
  ownedPaths: readonly string[],
): string[] {
  return ownedPaths
    .map((ownedPath) => toArtifactNamespaceRelativePath(namespace, ownedPath))
    .sort();
}

function sortChanges(changes: readonly ArtifactChange[]): ArtifactChange[] {
  return [...changes].sort((left, right) =>
    getChangePath(left).localeCompare(getChangePath(right)),
  );
}

function createAuthenticatedPlan(options: {
  baseOwnedPaths: readonly string[];
  baseRevision: MaterializationRevision;
  changes: readonly ArtifactChange[];
  namespace: LiminaArtifactNamespace;
  ownedPaths: readonly string[];
  revisionValidated: boolean;
}): ArtifactPlan {
  assertLiminaArtifactNamespace(options.namespace);
  assertChangesContained(options.namespace, options.changes);
  const deletedPaths = collectDeletedPaths(options.namespace, options.changes);
  const relativeOwnedPaths = normalizeOwnedPaths({
    deletedPaths,
    namespace: options.namespace,
    ownedPaths: options.ownedPaths,
  });
  const plan = Object.freeze({
    [artifactPlanBrand]: true as const,
    baseOwnedPaths: Object.freeze(
      normalizeBaseOwnedPaths(options.namespace, options.baseOwnedPaths),
    ),
    baseRevision: options.baseRevision,
    changes: Object.freeze(sortChanges(options.changes)),
    generationToken: options.namespace.generationToken,
    ownedPaths: Object.freeze(relativeOwnedPaths),
    desiredRevision: createDesiredRevision(
      options.namespace,
      options.changes,
      relativeOwnedPaths,
    ),
    revisionValidated: options.revisionValidated,
  });
  authenticatedArtifactPlans.add(plan);
  return plan;
}

export function createArtifactPlan(
  namespace: LiminaArtifactNamespace,
  changes: readonly ArtifactChange[],
  ownedPaths: readonly string[],
): ArtifactPlan {
  return createAuthenticatedPlan({
    baseOwnedPaths: [],
    baseRevision: createMaterializationRevision([]),
    changes,
    namespace,
    ownedPaths,
    revisionValidated: false,
  });
}

export function createRevisionedArtifactPlan(
  namespace: LiminaArtifactNamespace,
  changes: readonly ArtifactChange[],
  options: ArtifactPlanRevisionOptions & {
    readonly ownedPaths: readonly string[];
  },
): ArtifactPlan {
  return createAuthenticatedPlan({
    ...options,
    changes,
    namespace,
    revisionValidated: true,
  });
}

export function assertArtifactPlan(plan: ArtifactPlan): void {
  if (!authenticatedArtifactPlans.has(plan)) {
    throw new Error('Unauthenticated generated artifact plan.');
  }
}
