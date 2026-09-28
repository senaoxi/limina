import { getCheckerAdapter } from '#checkers';
import {
  getActiveCheckers,
  type ResolvedCheckerConfig,
  type ResolvedLiminaConfig,
} from '#config/runner';
import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
import { normalizeAbsolutePath } from '#utils/path';
import { existsSync } from 'node:fs';
import type {
  CheckerEntryAvailability,
  CheckerRouteMetricsRecorder,
  CheckerRouteSnapshot,
  CheckerRouteSnapshotCollection,
  CheckerRouteTraversalSnapshot,
} from './action-types';
import { collectGraphProjectRouteFromRoot } from './graph-route-traversal';

interface SnapshotBuildContext {
  config: ResolvedLiminaConfig;
  generatedGraph: GeneratedTsconfigGraphResult | undefined;
  metrics: CheckerRouteMetricsRecorder | undefined;
  snapshots: CheckerRouteSnapshot[];
  traversals: Map<string, CheckerRouteTraversalSnapshot>;
}

function supportsSourceGraph(checker: ResolvedCheckerConfig): boolean {
  const adapter = getCheckerAdapter(checker.name);
  return adapter?.sourceGraph === true;
}

function createCheckerRouteSnapshot(options: {
  checker: ResolvedCheckerConfig;
  entryAvailability: CheckerEntryAvailability;
  normalizedRootConfigPath?: string;
  rootConfigPath?: string;
  supportsSourceGraph: boolean;
  traversal?: CheckerRouteTraversalSnapshot;
}): CheckerRouteSnapshot {
  return Object.freeze({
    checkerName: options.checker.name,
    checkerPreset: options.checker.name,
    entryAvailability: options.entryAvailability,
    extensions: Object.freeze([...options.checker.extensions]),
    normalizedRootConfigPath: options.normalizedRootConfigPath,
    rootConfigPath: options.rootConfigPath,
    supportsSourceGraph: options.supportsSourceGraph,
    traversal: options.traversal,
  });
}

function getCheckerRootConfigPath(
  checker: ResolvedCheckerConfig,
  generatedGraph: GeneratedTsconfigGraphResult | undefined,
): string | undefined {
  return generatedGraph?.checkerEntries.get(checker.name);
}

function isAvailableRootConfig(
  rootConfigPath: string,
  normalizedRootConfigPath: string,
  generatedGraph: GeneratedTsconfigGraphResult | undefined,
): boolean {
  if (existsSync(rootConfigPath)) {
    return true;
  }
  return generatedGraph?.generatedFiles.has(normalizedRootConfigPath) === true;
}

function recordTraversalMetric(
  metrics: CheckerRouteMetricsRecorder | undefined,
  kind: 'cache-hit' | 'traversal',
): void {
  metrics?.record({
    kind,
    name: 'checker-route-traversal',
    provider: 'checker-route-snapshot',
  });
}

function createTraversal(options: {
  context: SnapshotBuildContext;
  normalizedRootConfigPath: string;
}): CheckerRouteTraversalSnapshot {
  const result = collectGraphProjectRouteFromRoot({
    rootConfigPath: options.normalizedRootConfigPath,
    rootDir: options.context.config.rootDir,
    virtualFiles: options.context.generatedGraph?.generatedFiles,
  });
  return Object.freeze({
    diagnostics: Object.freeze([...result.diagnostics]),
    normalizedRootConfigPath: options.normalizedRootConfigPath,
    problems: Object.freeze([...result.problems]),
    projectPaths: Object.freeze([...result.projectPaths]),
  });
}

function getTraversal(options: {
  context: SnapshotBuildContext;
  normalizedRootConfigPath: string;
}): CheckerRouteTraversalSnapshot {
  const cached = options.context.traversals.get(
    options.normalizedRootConfigPath,
  );
  if (cached !== undefined) {
    recordTraversalMetric(options.context.metrics, 'cache-hit');
    return cached;
  }
  const traversal = createTraversal(options);
  options.context.traversals.set(options.normalizedRootConfigPath, traversal);
  recordTraversalMetric(options.context.metrics, 'traversal');
  return traversal;
}

function addMissingEntrySnapshot(
  checker: ResolvedCheckerConfig,
  context: SnapshotBuildContext,
): void {
  context.snapshots.push(
    createCheckerRouteSnapshot({
      checker,
      entryAvailability: 'missing-entry',
      supportsSourceGraph: supportsSourceGraph(checker),
    }),
  );
}

function addMissingConfigSnapshot(options: {
  checker: ResolvedCheckerConfig;
  context: SnapshotBuildContext;
  normalizedRootConfigPath: string;
  rootConfigPath: string;
}): void {
  options.context.snapshots.push(
    createCheckerRouteSnapshot({
      checker: options.checker,
      entryAvailability: 'missing-config',
      normalizedRootConfigPath: options.normalizedRootConfigPath,
      rootConfigPath: options.rootConfigPath,
      supportsSourceGraph: supportsSourceGraph(options.checker),
    }),
  );
}

function addAvailableSnapshot(options: {
  checker: ResolvedCheckerConfig;
  context: SnapshotBuildContext;
  normalizedRootConfigPath: string;
  rootConfigPath: string;
}): void {
  options.context.snapshots.push(
    createCheckerRouteSnapshot({
      checker: options.checker,
      entryAvailability: 'available',
      normalizedRootConfigPath: options.normalizedRootConfigPath,
      rootConfigPath: options.rootConfigPath,
      supportsSourceGraph: supportsSourceGraph(options.checker),
      traversal: getTraversal({
        context: options.context,
        normalizedRootConfigPath: options.normalizedRootConfigPath,
      }),
    }),
  );
}

function collectCheckerSnapshot(
  checker: ResolvedCheckerConfig,
  context: SnapshotBuildContext,
): void {
  const rootConfigPath = getCheckerRootConfigPath(
    checker,
    context.generatedGraph,
  );
  if (rootConfigPath === undefined) {
    addMissingEntrySnapshot(checker, context);
    return;
  }
  const normalizedRootConfigPath = normalizeAbsolutePath(rootConfigPath);
  if (
    !isAvailableRootConfig(
      rootConfigPath,
      normalizedRootConfigPath,
      context.generatedGraph,
    )
  ) {
    addMissingConfigSnapshot({
      checker,
      context,
      normalizedRootConfigPath,
      rootConfigPath,
    });
    return;
  }
  addAvailableSnapshot({
    checker,
    context,
    normalizedRootConfigPath,
    rootConfigPath,
  });
}

function recordProjectionMetrics(context: SnapshotBuildContext): void {
  context.metrics?.record({
    count: context.snapshots.length,
    kind: 'checker-snapshot',
    name: 'checker-route-projection',
    provider: 'checker-route-snapshot',
  });
  context.metrics?.record({
    count: context.traversals.size,
    kind: 'unique-entry-root',
    name: 'checker-route-projection',
    provider: 'checker-route-snapshot',
  });
}

function resolveSnapshotCheckers(
  config: ResolvedLiminaConfig,
  generatedGraph: GeneratedTsconfigGraphResult | undefined,
): readonly ResolvedCheckerConfig[] {
  if (generatedGraph !== undefined) {
    return generatedGraph.checkers;
  }
  return getActiveCheckers(config);
}

function getGeneratedFiles(
  generatedGraph: GeneratedTsconfigGraphResult | undefined,
): ReadonlyMap<string, string> | undefined {
  if (generatedGraph === undefined) {
    return undefined;
  }
  return generatedGraph.generatedFiles;
}

export function collectCheckerRouteSnapshot(
  config: ResolvedLiminaConfig,
  generatedGraph?: GeneratedTsconfigGraphResult,
  metrics?: CheckerRouteMetricsRecorder,
): CheckerRouteSnapshotCollection {
  const context: SnapshotBuildContext = {
    config,
    generatedGraph,
    metrics,
    snapshots: [],
    traversals: new Map(),
  };
  for (const checker of resolveSnapshotCheckers(config, generatedGraph)) {
    collectCheckerSnapshot(checker, context);
  }
  recordProjectionMetrics(context);
  return Object.freeze({
    checkers: Object.freeze(context.snapshots),
    generatedFiles: getGeneratedFiles(generatedGraph),
    metrics,
    traversalCount: context.traversals.size,
    uniqueValidCheckerEntryRoots: context.traversals.size,
  });
}
