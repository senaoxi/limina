import { isBuildCapablePreset } from '#checkers';
import type { ResolvedLiminaConfig } from '#config/runner';
import { toRelativePath } from '#utils/path';
import { colorAllBuildComponents } from './checker-build-coloring-components';
import { isBuildColoringCandidate } from './checker-build-coloring-state';
import type { CheckerOwnershipDiscovery } from './checker-ownership-discovery';
import { createActualMembershipIndex } from './checker-ownership-membership';
import type {
  CheckerDependencyFact,
  TypeConfigOwnershipState,
} from './checker-ownership-types';
import type { FileOwnerLookup } from './file-owner-lookup';
import {
  readGraphRules,
  readImplicitReferences,
} from './generated/config-readers';
import { isDeniedGeneratedReferenceForConfig } from './reference-policy';

export interface ColoringEdge {
  from: string;
  reason: string;
  to: string;
}
interface ColoringGraph {
  adjacency: Map<string, Set<string>>;
  edges: ColoringEdge[];
}

function isBuildCandidate(state: TypeConfigOwnershipState): boolean {
  return isBuildColoringCandidate(state, isBuildCapablePreset);
}

function addEdge(options: { edge: ColoringEdge; graph: ColoringGraph }): void {
  if (options.edge.from === options.edge.to) return;
  options.graph.adjacency.get(options.edge.from)!.add(options.edge.to);
  options.graph.adjacency.get(options.edge.to)!.add(options.edge.from);
  options.graph.edges.push(options.edge);
}

function getBuildLeaves(
  discovery: CheckerOwnershipDiscovery,
  paths: readonly string[],
): string[] {
  return paths.filter((configPath) => {
    const state = discovery.plan.typeConfigs.get(configPath);
    return state !== undefined && isBuildCandidate(state);
  });
}

function addSolutionClosureEdges(options: {
  discovery: CheckerOwnershipDiscovery;
  graph: ColoringGraph;
  leafConfigPaths: readonly string[];
  solutionPath: string;
}): void {
  const [first, ...remaining] = getBuildLeaves(
    options.discovery,
    options.leafConfigPaths,
  );
  if (first === undefined) return;
  for (const leaf of remaining) {
    addEdge({
      edge: {
        from: first,
        reason: `solution ${options.solutionPath}`,
        to: leaf,
      },
      graph: options.graph,
    });
  }
}

function addSolutionEdges(options: {
  discovery: CheckerOwnershipDiscovery;
  graph: ColoringGraph;
}): void {
  for (const solution of options.discovery.plan.solutions.values()) {
    addSolutionClosureEdges({
      ...options,
      leafConfigPaths: solution.leafConfigPaths,
      solutionPath: solution.configPath,
    });
  }
}

function getUniqueFactTarget(options: {
  fact: CheckerDependencyFact;
  membership: FileOwnerLookup;
}): string | null {
  return options.fact.physicalTargetPath === null
    ? null
    : getSingleOwner(options.membership.get(options.fact.physicalTargetPath));
}

function getSingleOwner(owners: string[] | undefined): string | null {
  return owners === undefined || owners.length !== 1 ? null : owners[0]!;
}

function isDeclarationRelationFact(fact: CheckerDependencyFact): boolean {
  return fact.referenceRequirement != null;
}

function getPassGraphRules(options: {
  config: ResolvedLiminaConfig;
  consumer: TypeConfigOwnershipState;
  graphRulesByConfigPath: Map<string, readonly string[]>;
}): readonly string[] {
  const key = options.consumer.configPath;
  let rules = options.graphRulesByConfigPath.get(key);
  if (rules === undefined) {
    rules = readGraphRules(options.config, key);
    options.graphRulesByConfigPath.set(key, rules);
  }
  return rules;
}

function createBuildDependencyEdge(options: {
  config: ResolvedLiminaConfig;
  consumer: TypeConfigOwnershipState;
  fact: CheckerDependencyFact;
  graphRulesByConfigPath: Map<string, readonly string[]>;
  provider: TypeConfigOwnershipState;
}): ColoringEdge | null {
  if (
    ![options.consumer, options.provider].every(isBuildCandidate) ||
    isDeniedGeneratedReferenceForConfig({
      config: options.config,
      graphRules: getPassGraphRules(options),
      targetSourceConfigPath: options.provider.configPath,
    })
  )
    return null;
  return {
    from: options.consumer.configPath,
    reason: `${toRelativePath(options.config.rootDir, options.fact.importRecord.filePath)}:${options.fact.importRecord.line} imports ${options.fact.importRecord.specifier}`,
    to: options.provider.configPath,
  };
}

function createManagedDependencyEdge(options: {
  config: ResolvedLiminaConfig;
  discovery: CheckerOwnershipDiscovery;
  fact: CheckerDependencyFact;
  graphRulesByConfigPath: Map<string, readonly string[]>;
  target: string;
}): ColoringEdge | null {
  const consumer = options.discovery.plan.typeConfigs.get(
    options.fact.consumerConfigPath,
  );
  const provider = options.discovery.plan.typeConfigs.get(options.target);
  return consumer === undefined || provider === undefined
    ? null
    : createBuildDependencyEdge({ ...options, consumer, provider });
}

function createDependencyEdge(options: {
  config: ResolvedLiminaConfig;
  discovery: CheckerOwnershipDiscovery;
  fact: CheckerDependencyFact;
  graphRulesByConfigPath: Map<string, readonly string[]>;
  membership: FileOwnerLookup;
}): ColoringEdge | null {
  if (!isDeclarationRelationFact(options.fact)) return null;
  const target = getUniqueFactTarget(options);
  return target === null
    ? null
    : createManagedDependencyEdge({ ...options, target });
}

function addDependencyEdges(options: {
  config: ResolvedLiminaConfig;
  discovery: CheckerOwnershipDiscovery;
  graph: ColoringGraph;
}): void {
  const membership = createActualMembershipIndex(
    options.discovery.projectByConfigPath,
  );
  const graphRulesByConfigPath = new Map<string, readonly string[]>();
  for (const fact of options.discovery.plan.dependencyFacts) {
    const edge = createDependencyEdge({
      ...options,
      fact,
      graphRulesByConfigPath,
      membership,
    });
    if (edge !== null) addEdge({ edge, graph: options.graph });
  }
}

function createImplicitReferenceEdge(options: {
  consumer: TypeConfigOwnershipState;
  discovery: CheckerOwnershipDiscovery;
  path: string;
  targetConfigPath: string;
}): ColoringEdge | null {
  const provider = options.discovery.plan.typeConfigs.get(
    options.targetConfigPath,
  );
  if (provider === undefined) return null;
  return isBuildCandidate(provider)
    ? {
        from: options.consumer.configPath,
        reason: `liminaOptions.implicitRefs ${options.path}`,
        to: provider.configPath,
      }
    : null;
}

function addConsumerImplicitEdges(options: {
  config: ResolvedLiminaConfig;
  consumer: TypeConfigOwnershipState;
  discovery: CheckerOwnershipDiscovery;
  graph: ColoringGraph;
  problems: string[];
}): void {
  const references = readImplicitReferences(
    options.config,
    options.consumer.configPath,
  );
  options.problems.push(...references.problems);
  for (const reference of references.implicitRefs) {
    const edge = createImplicitReferenceEdge({
      ...options,
      path: reference.path,
      targetConfigPath: reference.targetConfigPath,
    });
    if (edge !== null) addEdge({ edge, graph: options.graph });
  }
}

function addImplicitReferenceEdges(options: {
  config: ResolvedLiminaConfig;
  discovery: CheckerOwnershipDiscovery;
  graph: ColoringGraph;
  problems: string[];
}): void {
  const consumers = options.discovery.plan.typeConfigs
    .values()
    .filter(isBuildCandidate)
    .toArray();
  for (const consumer of consumers)
    addConsumerImplicitEdges({ ...options, consumer });
}

export function colorBuildCheckerComponents(options: {
  config: ResolvedLiminaConfig;
  discovery: CheckerOwnershipDiscovery;
}): string[] {
  const candidates = options.discovery.plan.typeConfigs
    .values()
    .filter(isBuildCandidate)
    .toArray();
  const graph: ColoringGraph = {
    adjacency: new Map(
      candidates.map((state) => [state.configPath, new Set<string>()]),
    ),
    edges: [],
  };
  const problems: string[] = [];
  addSolutionEdges({ discovery: options.discovery, graph });
  addDependencyEdges({ ...options, graph });
  addImplicitReferenceEdges({ ...options, graph, problems });
  colorAllBuildComponents({ ...options, ...graph, problems });
  return problems;
}
