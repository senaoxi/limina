import {
  type CheckerProjectParseContext,
  normalizeExtensions,
} from '#checkers';
import type { ResolvedLiminaConfig } from '#config/runner';
import type {
  GeneratedTsconfigGraphResult,
  GovernedSourceUnit,
} from '#core/build-graph/runner';
import { uniqueValues } from '#utils/collections';
import { capabilityDiscoveryExtensions } from '../build-graph/generated/file-extensions';
import type {
  CheckerRouteSnapshot,
  CheckerRouteSnapshotCollection,
  CollectCheckerGraphProjectRoutesResult,
  CollectSourceGraphProjectExtensionsResult,
} from './action-types';
import { projectCheckerRoutesForProjection } from './checker-route-projection';
import { collectCheckerRouteSnapshot } from './checker-route-snapshot';
import { isDtsConfigPath } from './config-paths';

interface SourceExtensionState {
  projectContextsByPath: Map<string, CheckerProjectParseContext>;
  projectExtensionsByPath: Map<string, string[]>;
}

function hasGovernedSources(
  generatedGraph: GeneratedTsconfigGraphResult | undefined,
): generatedGraph is GeneratedTsconfigGraphResult {
  return (
    generatedGraph !== undefined &&
    generatedGraph.governedSources instanceof Map &&
    [...generatedGraph.governedSources.values()].some(
      (governedSources) => governedSources.size > 0,
    )
  );
}

function recordSourceExtensionProjection(
  snapshot: CheckerRouteSnapshotCollection,
): void {
  snapshot.metrics?.record({
    kind: 'source-extension',
    name: 'checker-route-projection',
    provider: 'checker-route-snapshot',
  });
}

function getProjectContext(
  context: CheckerProjectParseContext | undefined,
): CheckerProjectParseContext {
  if (context !== undefined) return context;
  return { checkerPresets: [], extensions: [] };
}

function assertCompatibleVueIdentities(options: {
  current: CheckerProjectParseContext['vueSemanticIdentity'];
  incoming: CheckerProjectParseContext['vueSemanticIdentity'];
  projectPath: string;
}): void {
  const currentId = getVueSemanticIdentityId(options.current);
  const incomingId = getVueSemanticIdentityId(options.incoming);
  const conflicts = [
    currentId !== undefined,
    incomingId !== undefined,
    currentId !== incomingId,
  ].every(Boolean);
  if (!conflicts) return;
  throw new Error(
    `Generated project received conflicting Vue semantic identities: ${options.projectPath}.`,
  );
}

function getVueSemanticIdentityId(
  identity: CheckerProjectParseContext['vueSemanticIdentity'],
): string | undefined {
  if (identity === undefined) return undefined;
  return identity.id;
}

function getProjectExtensions(
  extensions: string[] | undefined,
): readonly string[] {
  if (extensions === undefined) return [];
  return extensions;
}

function mergeProjectContext(options: {
  checkerPreset: CheckerRouteSnapshot['checkerPreset'];
  incomingContext?: CheckerProjectParseContext;
  projectPath: string;
  routeExtensions: string[];
  state: SourceExtensionState;
}): void {
  const current = options.state.projectContextsByPath.get(options.projectPath);
  const context = getProjectContext(current);
  const incomingContext = getProjectContext(options.incomingContext);
  const currentIdentity = context.vueSemanticIdentity;
  const incomingIdentity = incomingContext.vueSemanticIdentity;
  assertCompatibleVueIdentities({
    current: currentIdentity,
    incoming: incomingIdentity,
    projectPath: options.projectPath,
  });
  options.state.projectContextsByPath.set(options.projectPath, {
    checkerPresets: uniqueValues([
      ...context.checkerPresets,
      ...incomingContext.checkerPresets,
      options.checkerPreset,
    ]),
    extensions: normalizeExtensions([
      ...context.extensions,
      ...incomingContext.extensions,
      ...options.routeExtensions,
    ]),
    vueSemanticIdentity: currentIdentity || incomingIdentity,
  });
  const existing = options.state.projectExtensionsByPath.get(
    options.projectPath,
  );
  options.state.projectExtensionsByPath.set(
    options.projectPath,
    normalizeExtensions([
      ...getProjectExtensions(existing),
      ...options.routeExtensions,
    ]),
  );
}

function projectRouteExtensions(options: {
  config: ResolvedLiminaConfig;
  route: CollectCheckerGraphProjectRoutesResult['routes'][number];
  snapshot: CheckerRouteSnapshotCollection;
  state: SourceExtensionState;
}): void {
  for (const projectPath of options.route.projectPaths) {
    if (!isDtsConfigPath(projectPath)) {
      continue;
    }
    mergeProjectContext({
      checkerPreset: options.route.checkerPreset,
      projectPath,
      routeExtensions: normalizeExtensions(options.route.extensions),
      state: options.state,
    });
  }
}

function projectGovernedSourceExtensions(options: {
  generatedGraph: GeneratedTsconfigGraphResult;
  state: SourceExtensionState;
}): void {
  for (const governedSources of options.generatedGraph.governedSources.values()) {
    projectGovernedUnits({
      governedSources,
      state: options.state,
    });
  }
}

function getGovernedProjectPath(unit: GovernedSourceUnit): string {
  if (unit.buildProjection.kind === 'framework-checker') {
    return unit.configPath;
  }
  return 'buildConfigPath' in unit.buildProjection
    ? unit.buildProjection.buildConfigPath
    : unit.buildProjection.dtsConfigPath;
}

function getGovernedParserContext(unit: GovernedSourceUnit): {
  checkerPreset: CheckerProjectParseContext['checkerPresets'][number];
  incomingContext: CheckerProjectParseContext;
} {
  if (unit.buildProjection.kind === 'framework-checker') {
    return {
      checkerPreset: 'tsc',
      incomingContext: {
        checkerPresets: ['tsc'],
        extensions: unit.context.extensions,
      },
    };
  }
  return {
    checkerPreset: unit.primaryCheckerName,
    incomingContext: unit.context,
  };
}

function projectGovernedUnits(options: {
  governedSources: ReadonlyMap<string, GovernedSourceUnit>;
  state: SourceExtensionState;
}): void {
  for (const unit of options.governedSources.values()) {
    const parserContext = getGovernedParserContext(unit);
    const extensions = normalizeExtensions([
      ...capabilityDiscoveryExtensions,
      ...unit.context.extensions,
    ]);
    mergeProjectContext({
      checkerPreset: parserContext.checkerPreset,
      incomingContext: parserContext.incomingContext,
      projectPath: getGovernedProjectPath(unit),
      routeExtensions: extensions,
      state: options.state,
    });
  }
}

export function projectSourceGraphProjectExtensions(
  config: ResolvedLiminaConfig,
  snapshot: CheckerRouteSnapshotCollection,
  generatedGraph?: GeneratedTsconfigGraphResult,
): CollectSourceGraphProjectExtensionsResult {
  recordSourceExtensionProjection(snapshot);
  const routeCollection = projectCheckerRoutesForProjection(
    config,
    snapshot,
    'graph',
  );
  const state: SourceExtensionState = {
    projectContextsByPath: new Map(),
    projectExtensionsByPath: new Map(),
  };
  if (hasGovernedSources(generatedGraph)) {
    projectGovernedSourceExtensions({
      generatedGraph,
      state,
    });
  } else {
    for (const route of routeCollection.routes) {
      projectRouteExtensions({ config, route, snapshot, state });
    }
  }
  return {
    diagnostics: routeCollection.diagnostics,
    problems: routeCollection.problems,
    projectContextsByPath: state.projectContextsByPath,
    projectExtensionsByPath: state.projectExtensionsByPath,
  };
}

export function collectSourceGraphProjectExtensions(
  config: ResolvedLiminaConfig,
  generatedGraph?: GeneratedTsconfigGraphResult,
): CollectSourceGraphProjectExtensionsResult {
  return projectSourceGraphProjectExtensions(
    config,
    collectCheckerRouteSnapshot(config, generatedGraph),
    generatedGraph,
  );
}
