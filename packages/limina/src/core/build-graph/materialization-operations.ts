import { readFile, rm } from 'node:fs/promises';
import { performAtomicJsonWrite } from '../../check-reporting/atomic-write-operation';
import {
  assertArtifactPathLexicallyContained,
  assertArtifactPathOperationSafe,
  assertArtifactPlanPathsOperationSafe,
  ensureArtifactParentDirectory,
  type LiminaArtifactNamespace,
  resolveArtifactNamespaceRelativePath,
} from '../../domain/artifacts/namespace';
import {
  type ArtifactChange,
  type ArtifactPlan,
  createMaterializationRevision,
} from '../../domain/artifacts/plan';
import type { MaterializeGeneratedArtifactPlanOptions } from './materializer';

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

export function orderArtifactChanges(plan: ArtifactPlan): ArtifactChange[] {
  return [...plan.changes].sort(compareArtifactChanges);
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
    assertArtifactPathLexicallyContained(
      namespace,
      resolveArtifactNamespaceRelativePath(namespace, ownedPath),
    );
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
  await performAtomicJsonWrite({
    namespace,
    options: {
      appendNewline: false,
      serialize: () =>
        typeof change.artifact.content === 'string'
          ? change.artifact.content
          : Buffer.from(change.artifact.content).toString(),
    },
    targetPath: change.artifact.path,
    value: change.artifact.content,
  });
}

export async function validateArtifactPlanSafety(options: {
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

type TargetArtifact = Exclude<ArtifactChange, { status: 'delete' }>['artifact'];

function addTargetArtifact(options: {
  artifacts: Map<string, TargetArtifact>;
  change: Exclude<ArtifactChange, { status: 'delete' }>;
  namespace: LiminaArtifactNamespace;
  ownedPaths: readonly string[];
}): void {
  const relativePath = options.ownedPaths.find(
    (ownedPath) =>
      resolveArtifactNamespaceRelativePath(options.namespace, ownedPath) ===
      options.change.artifact.path,
  );
  if (relativePath === undefined) return;
  options.artifacts.set(relativePath, options.change.artifact);
}

export function getTargetArtifacts(
  namespace: LiminaArtifactNamespace,
  plan: ArtifactPlan,
): Map<string, TargetArtifact> {
  const artifacts = new Map<string, TargetArtifact>();
  for (const change of plan.changes) {
    if (change.status === 'delete') continue;
    addTargetArtifact({
      artifacts,
      change,
      namespace,
      ownedPaths: plan.ownedPaths,
    });
  }
  return artifacts;
}

export async function deleteNonTargetOwnedPaths(options: {
  namespace: LiminaArtifactNamespace;
  ownedPathUniverse: readonly string[];
  targetOwnedPaths: ReadonlySet<string>;
  materialization: MaterializeGeneratedArtifactPlanOptions;
}): Promise<void> {
  for (const relativePath of options.ownedPathUniverse) {
    if (options.targetOwnedPaths.has(relativePath)) continue;
    await applyDeleteChange(
      options.namespace,
      {
        path: resolveArtifactNamespaceRelativePath(
          options.namespace,
          relativePath,
        ),
        status: 'delete',
      },
      options.materialization,
    );
  }
}

function skipsUnchangedChange(force: boolean, change: ArtifactChange): boolean {
  return !force && change.status === 'unchanged';
}

function shouldWriteChange(options: {
  change: ArtifactChange;
  force: boolean;
  manifestOnly: boolean;
}): options is {
  change: Exclude<ArtifactChange, { status: 'delete' }>;
  force: boolean;
  manifestOnly: boolean;
} {
  if (options.change.status === 'delete') return false;
  if (skipsUnchangedChange(options.force, options.change)) return false;
  return isGeneratedManifestChange(options.change) === options.manifestOnly;
}

function asWriteChange(
  change: Exclude<ArtifactChange, { status: 'delete' }>,
): Exclude<ArtifactChange, { status: 'delete' | 'unchanged' }> {
  if (change.status !== 'unchanged') return change;
  return { artifact: change.artifact, status: 'update' };
}

export async function writeTargetArtifacts(options: {
  force: boolean;
  manifestOnly: boolean;
  materialization: MaterializeGeneratedArtifactPlanOptions;
  namespace: LiminaArtifactNamespace;
  plan: ArtifactPlan;
}): Promise<void> {
  const changes = orderArtifactChanges(options.plan).filter(
    (change): change is Exclude<ArtifactChange, { status: 'delete' }> =>
      shouldWriteChange({ ...options, change }),
  );
  for (const change of changes) {
    await applyWriteChange(
      options.namespace,
      asWriteChange(change),
      options.materialization,
    );
  }
}

async function readDesiredEntries(options: {
  namespace: LiminaArtifactNamespace;
  plan: ArtifactPlan;
  targetArtifacts: Map<string, TargetArtifact>;
}) {
  const entries = [];
  for (const relativePath of options.plan.ownedPaths) {
    const artifact = options.targetArtifacts.get(relativePath);
    if (artifact === undefined) {
      throw new Error(
        `Generated-artifact plan is missing desired content for ${relativePath}.`,
      );
    }
    const content = await readFile(
      resolveArtifactNamespaceRelativePath(options.namespace, relativePath),
    );
    entries.push({ content, path: relativePath });
  }
  return entries;
}

export async function verifyDesiredTree(options: {
  namespace: LiminaArtifactNamespace;
  plan: ArtifactPlan;
  targetArtifacts: Map<string, TargetArtifact>;
}): Promise<void> {
  const entries = await readDesiredEntries(options);
  if (createMaterializationRevision(entries) === options.plan.desiredRevision) {
    return;
  }
  throw new Error(
    'Generated-artifact desired tree verification failed after materialization.',
  );
}
