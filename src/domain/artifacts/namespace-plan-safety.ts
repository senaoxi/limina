import { compareCodeUnits } from '#utils/collections';
import path from 'pathe';
import type {
  ArtifactSafetyMetricsRecorder,
  LiminaArtifactNamespace,
} from './namespace-core';
import {
  assertLiminaArtifactNamespace,
  normalizeArtifactAbsolutePath,
} from './namespace-core';
import type { ArtifactPathSafetyRole } from './namespace-safety-shared';
import {
  assertArtifactPathStatsSafe,
  assertProjectedCanonicalContainment,
  getRelativeSegments,
  lstatIfPresent,
} from './namespace-safety-shared';

function addRole(
  nodes: Map<string, Set<ArtifactPathSafetyRole>>,
  targetPath: string,
  role: ArtifactPathSafetyRole,
): void {
  const normalizedTarget = normalizeArtifactAbsolutePath(targetPath);
  const roles = nodes.get(normalizedTarget) ?? new Set();
  roles.add(role);
  nodes.set(normalizedTarget, roles);
}

function getSegmentRole(
  index: number,
  segmentCount: number,
): ArtifactPathSafetyRole {
  return index === segmentCount - 1 ? 'target-file' : 'parent-directory';
}

function addTargetNodes(options: {
  namespace: LiminaArtifactNamespace;
  nodes: Map<string, Set<ArtifactPathSafetyRole>>;
  targetPath: string;
}): void {
  const normalizedTarget = assertProjectedCanonicalContainment(
    options.namespace,
    options.targetPath,
  );
  addRole(options.nodes, options.namespace.rootDir, 'parent-directory');
  const segments = getRelativeSegments(options.namespace, normalizedTarget);
  let cursor = options.namespace.rootDir;

  for (const [index, segment] of segments.entries()) {
    cursor = path.join(cursor, segment);
    addRole(options.nodes, cursor, getSegmentRole(index, segments.length));
  }

  if (segments.length === 0) {
    addRole(options.nodes, normalizedTarget, 'target-file');
  }
}

function collectPlanNodes(
  namespace: LiminaArtifactNamespace,
  targetPaths: readonly string[],
): Map<string, Set<ArtifactPathSafetyRole>> {
  const nodes = new Map<string, Set<ArtifactPathSafetyRole>>();

  for (const targetPath of targetPaths) {
    addTargetNodes({ namespace, nodes, targetPath });
  }

  return nodes;
}

function getPathDepth(
  namespace: LiminaArtifactNamespace,
  targetPath: string,
): number {
  return path
    .relative(namespace.rootDir, targetPath)
    .split(path.sep)
    .filter(Boolean).length;
}

function comparePlanNodes(
  namespace: LiminaArtifactNamespace,
  left: string,
  right: string,
): number {
  const depthComparison =
    getPathDepth(namespace, left) - getPathDepth(namespace, right);
  return depthComparison || compareCodeUnits(left, right);
}

function sortPlanNodes(
  namespace: LiminaArtifactNamespace,
  nodes: ReadonlyMap<string, Set<ArtifactPathSafetyRole>>,
): [string, Set<ArtifactPathSafetyRole>][] {
  return [...nodes.entries()].sort(([left], [right]) =>
    comparePlanNodes(namespace, left, right),
  );
}

function recordPlanNodeCount(
  metrics: ArtifactSafetyMetricsRecorder | undefined,
  count: number,
): void {
  metrics?.record({
    count,
    kind: 'batch',
    name: 'artifact-safety-unique-node',
    provider: 'artifact-namespace',
  });
}

async function checkPlanNode(options: {
  metrics: ArtifactSafetyMetricsRecorder | undefined;
  roles: ReadonlySet<ArtifactPathSafetyRole>;
  targetPath: string;
}): Promise<void> {
  options.metrics?.record({
    kind: 'batch',
    name: 'artifact-safety-lstat',
    provider: 'artifact-namespace',
  });
  const stats = await lstatIfPresent(options.targetPath);

  if (stats !== undefined) {
    assertArtifactPathStatsSafe(options.targetPath, stats, options.roles);
  }
}

export async function assertArtifactPlanPathsOperationSafe(
  namespace: LiminaArtifactNamespace,
  targetPaths: readonly string[],
  options: { metrics?: ArtifactSafetyMetricsRecorder } = {},
): Promise<void> {
  assertLiminaArtifactNamespace(namespace);
  const orderedNodes = sortPlanNodes(
    namespace,
    collectPlanNodes(namespace, targetPaths),
  );
  recordPlanNodeCount(options.metrics, orderedNodes.length);

  for (const [targetPath, roles] of orderedNodes) {
    await checkPlanNode({ metrics: options.metrics, roles, targetPath });
  }
}
