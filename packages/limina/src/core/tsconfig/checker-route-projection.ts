import type { ResolvedLiminaConfig } from '#config/runner';
import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
import { toRelativePath } from '#utils/path';
import type {
  CheckerGraphRouteDiagnostic,
  CheckerRouteSnapshot,
  CheckerRouteSnapshotCollection,
  CollectCheckerGraphProjectRoutesResult,
} from './action-types';
import { collectCheckerRouteSnapshot } from './checker-route-snapshot';

type RouteProjection = 'entry' | 'graph';

interface RouteProjectionState {
  diagnostics: CheckerGraphRouteDiagnostic[];
  problems: string[];
  routes: CollectCheckerGraphProjectRoutesResult['routes'];
}

function shouldProjectChecker(
  checker: CheckerRouteSnapshot,
  projection: RouteProjection,
): boolean {
  if (projection === 'entry') {
    return true;
  }
  return checker.supportsSourceGraph;
}

function getMissingEntryText(projection: RouteProjection): {
  reason: string;
  title: string;
} {
  if (projection === 'graph') {
    return {
      reason:
        'run limina graph prepare before collecting checker graph routes.',
      title: 'Missing generated checker graph entry',
    };
  }
  return {
    reason: 'run limina graph prepare before collecting checker entry routes.',
    title: 'Missing generated checker entry',
  };
}

function addMissingEntry(options: {
  checker: CheckerRouteSnapshot;
  projection: RouteProjection;
  state: RouteProjectionState;
}): void {
  const text = getMissingEntryText(options.projection);
  const detailLines = [
    `${text.title}:`,
    `  checker: ${options.checker.checkerName}`,
    `  reason: ${text.reason}`,
  ];
  options.state.problems.push(detailLines.join('\n'));
  options.state.diagnostics.push({
    checkerName: options.checker.checkerName,
    detailLines,
    reason: text.reason,
    title: text.title,
  });
}

function getMissingConfigTitle(projection: RouteProjection): string {
  return projection === 'graph'
    ? 'Checker graph entry references a missing tsconfig'
    : 'Checker entry references a missing tsconfig';
}

function addMissingConfig(options: {
  checker: CheckerRouteSnapshot;
  config: ResolvedLiminaConfig;
  projection: RouteProjection;
  state: RouteProjectionState;
}): void {
  const title = getMissingConfigTitle(options.projection);
  const rootConfigPath = options.checker.rootConfigPath ?? '';
  const detailLines = [
    `${title}:`,
    `  checker: ${options.checker.checkerName}`,
    `  config: ${toRelativePath(options.config.rootDir, rootConfigPath)}`,
  ];
  options.state.problems.push(detailLines.join('\n'));
  options.state.diagnostics.push({
    checkerName: options.checker.checkerName,
    detailLines,
    filePath: options.checker.rootConfigPath,
    reason:
      'Graph check found architecture, dependency, resolver, or config violations.',
    title,
  });
}

function hasAvailableRoute(
  checker: CheckerRouteSnapshot,
): checker is CheckerRouteSnapshot & {
  rootConfigPath: string;
  traversal: NonNullable<CheckerRouteSnapshot['traversal']>;
} {
  if (checker.rootConfigPath === undefined) {
    return false;
  }
  return checker.traversal !== undefined;
}

function addAvailableRoute(
  checker: CheckerRouteSnapshot,
  state: RouteProjectionState,
): void {
  if (!hasAvailableRoute(checker)) {
    return;
  }
  state.problems.push(...checker.traversal.problems);
  for (const diagnostic of checker.traversal.diagnostics) {
    state.diagnostics.push({ checkerName: checker.checkerName, ...diagnostic });
  }
  state.routes.push({
    checkerName: checker.checkerName,
    checkerPreset: checker.checkerPreset,
    extensions: [...checker.extensions],
    projectPaths: [...checker.traversal.projectPaths],
    rootConfigPath: checker.rootConfigPath,
  });
}

function projectCheckerAvailability(options: {
  checker: CheckerRouteSnapshot;
  config: ResolvedLiminaConfig;
  projection: RouteProjection;
  state: RouteProjectionState;
}): void {
  if (options.checker.entryAvailability === 'missing-entry') {
    addMissingEntry(options);
    return;
  }
  if (options.checker.entryAvailability === 'missing-config') {
    addMissingConfig(options);
    return;
  }
  addAvailableRoute(options.checker, options.state);
}

function projectChecker(options: {
  checker: CheckerRouteSnapshot;
  config: ResolvedLiminaConfig;
  projection: RouteProjection;
  state: RouteProjectionState;
}): void {
  if (!shouldProjectChecker(options.checker, options.projection)) {
    return;
  }
  projectCheckerAvailability(options);
}

export function projectCheckerRoutesForProjection(
  config: ResolvedLiminaConfig,
  snapshot: CheckerRouteSnapshotCollection,
  projection: RouteProjection,
): CollectCheckerGraphProjectRoutesResult {
  const state: RouteProjectionState = {
    diagnostics: [],
    problems: [],
    routes: [],
  };
  for (const checker of snapshot.checkers) {
    projectChecker({ checker, config, projection, state });
  }
  return state;
}

function recordProjection(
  snapshot: CheckerRouteSnapshotCollection,
  kind: 'entry-route' | 'graph-route',
): void {
  snapshot.metrics?.record({
    kind,
    name: 'checker-route-projection',
    provider: 'checker-route-snapshot',
  });
}

export function projectGraphProjectRoutes(
  config: ResolvedLiminaConfig,
  snapshot: CheckerRouteSnapshotCollection,
): CollectCheckerGraphProjectRoutesResult {
  recordProjection(snapshot, 'graph-route');
  return projectCheckerRoutesForProjection(config, snapshot, 'graph');
}

export function projectCheckerEntryProjectRoutes(
  config: ResolvedLiminaConfig,
  snapshot: CheckerRouteSnapshotCollection,
): CollectCheckerGraphProjectRoutesResult {
  recordProjection(snapshot, 'entry-route');
  return projectCheckerRoutesForProjection(config, snapshot, 'entry');
}

export function collectGraphProjectRoutes(
  config: ResolvedLiminaConfig,
  generatedGraph?: GeneratedTsconfigGraphResult,
): CollectCheckerGraphProjectRoutesResult {
  return projectGraphProjectRoutes(
    config,
    collectCheckerRouteSnapshot(config, generatedGraph),
  );
}
