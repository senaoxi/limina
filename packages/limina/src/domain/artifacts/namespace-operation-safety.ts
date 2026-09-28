import { mkdir } from 'node:fs/promises';
import path from 'pathe';
import type {
  ArtifactSafetyMetricsRecorder,
  LiminaArtifactNamespace,
} from './namespace-core';
import type {
  ArtifactPathSafetyRole,
  ArtifactTargetKind,
} from './namespace-safety-shared';
import {
  assertArtifactPathStatsSafe,
  assertProjectedCanonicalContainment,
  getRelativeSegments,
  lstatIfPresent,
} from './namespace-safety-shared';

const targetRoleByKind: Readonly<
  Record<ArtifactTargetKind, ArtifactPathSafetyRole>
> = {
  directory: 'target-directory',
  file: 'target-file',
};

function createTargetRoles(
  targetKind: ArtifactTargetKind | undefined,
): ReadonlySet<ArtifactPathSafetyRole> {
  return targetKind === undefined
    ? new Set()
    : new Set([targetRoleByKind[targetKind]]);
}

function createOperationRoles(options: {
  cursor: string;
  normalizedTarget: string;
  targetKind: ArtifactTargetKind | undefined;
}): ReadonlySet<ArtifactPathSafetyRole> {
  if (options.cursor !== options.normalizedTarget) {
    return new Set(['parent-directory']);
  }

  return createTargetRoles(options.targetKind);
}

function collectOperationPaths(
  namespace: LiminaArtifactNamespace,
  normalizedTarget: string,
): string[] {
  const paths = [namespace.rootDir];
  let cursor = namespace.rootDir;

  for (const segment of getRelativeSegments(namespace, normalizedTarget)) {
    cursor = path.join(cursor, segment);
    paths.push(cursor);
  }

  return paths;
}

async function checkOperationPath(options: {
  normalizedTarget: string;
  targetKind: ArtifactTargetKind | undefined;
  targetPath: string;
}): Promise<void> {
  const stats = await lstatIfPresent(options.targetPath);

  if (stats === undefined) {
    return;
  }

  assertArtifactPathStatsSafe(
    options.targetPath,
    stats,
    createOperationRoles({
      cursor: options.targetPath,
      normalizedTarget: options.normalizedTarget,
      targetKind: options.targetKind,
    }),
  );
}

function recordImmediateRecheck(options: {
  metrics: ArtifactSafetyMetricsRecorder | undefined;
  phase: 'immediate' | undefined;
  targetKind: ArtifactTargetKind | undefined;
}): void {
  if (options.phase !== 'immediate') {
    return;
  }

  options.metrics?.record({
    kind: options.targetKind,
    name: 'artifact-safety-immediate-recheck',
    provider: 'artifact-namespace',
  });
}

export async function assertArtifactPathOperationSafe(
  namespace: LiminaArtifactNamespace,
  targetPath: string,
  options: {
    metrics?: ArtifactSafetyMetricsRecorder;
    phase?: 'immediate';
    targetKind?: ArtifactTargetKind;
  } = {},
): Promise<void> {
  const normalizedTarget = assertProjectedCanonicalContainment(
    namespace,
    targetPath,
  );
  recordImmediateRecheck({
    metrics: options.metrics,
    phase: options.phase,
    targetKind: options.targetKind,
  });

  for (const operationPath of collectOperationPaths(
    namespace,
    normalizedTarget,
  )) {
    await checkOperationPath({
      normalizedTarget,
      targetKind: options.targetKind,
      targetPath: operationPath,
    });
  }
}

export async function ensureArtifactParentDirectory(
  namespace: LiminaArtifactNamespace,
  targetPath: string,
  options: { metrics?: ArtifactSafetyMetricsRecorder } = {},
): Promise<void> {
  const safetyOptions = {
    metrics: options.metrics,
    phase: 'immediate' as const,
    targetKind: 'file' as const,
  };
  await assertArtifactPathOperationSafe(namespace, targetPath, safetyOptions);
  await mkdir(path.dirname(targetPath), { recursive: true });
  await assertArtifactPathOperationSafe(namespace, targetPath, safetyOptions);
}
