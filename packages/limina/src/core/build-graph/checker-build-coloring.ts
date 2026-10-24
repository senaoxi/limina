import { isBuildCapablePreset } from '#checkers';
import type { CheckerName, ResolvedLiminaInputs } from '#config/runner';
import { compareCodeUnits } from '#utils/collections';
import { toRelativePath } from '#utils/path';
import type { CheckerOwnershipDiscovery } from './checker-ownership-discovery';
import { addLocalCheckerRequirement } from './checker-ownership-evidence';
import {
  assertLockedDependencyFacts,
  nativeDependencyTarget,
} from './checker-ownership-fact-qualification';
import { createActualMembershipIndex } from './checker-ownership-membership';
import type {
  CheckerDependencyFact,
  TypeConfigOwnershipState,
} from './checker-ownership-types';
import { getUniqueConstraint } from './checker-solution-constraints';
import type { FileOwnerLookup } from './file-owner-lookup';
import { readImplicitReferences } from './generated/config-readers';

interface ColoringEdge {
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
  const nativeTarget = nativeDependencyTarget(options.fact);
  if (nativeTarget !== undefined) return nativeTarget;
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

function createBuildDependencyEdge(options: {
  config: ResolvedLiminaInputs;
  consumer: TypeConfigOwnershipState;
  fact: CheckerDependencyFact;
  provider: TypeConfigOwnershipState;
}): ColoringEdge | null {
  if (![options.consumer, options.provider].every(isBuildCandidate))
    return null;
  return {
    from: options.consumer.configPath,
    reason: `${toRelativePath(options.config.rootDir, options.fact.importRecord.filePath)}:${options.fact.importRecord.line} imports ${options.fact.importRecord.specifier}`,
    to: options.provider.configPath,
  };
}

function createManagedDependencyEdge(options: {
  config: ResolvedLiminaInputs;
  discovery: CheckerOwnershipDiscovery;
  fact: CheckerDependencyFact;
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
  config: ResolvedLiminaInputs;
  discovery: CheckerOwnershipDiscovery;
  fact: CheckerDependencyFact;
  membership: FileOwnerLookup;
}): ColoringEdge | null {
  if (!isDeclarationRelationFact(options.fact)) return null;
  const target = getUniqueFactTarget(options);
  return target === null
    ? null
    : createManagedDependencyEdge({ ...options, target });
}

function addDependencyEdges(options: {
  config: ResolvedLiminaInputs;
  discovery: CheckerOwnershipDiscovery;
  graph: ColoringGraph;
}): void {
  const membership = createActualMembershipIndex(
    options.discovery.projectByConfigPath,
  );
  for (const fact of options.discovery.plan.dependencyFacts) {
    const edge = createDependencyEdge({
      ...options,
      fact,
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
  config: ResolvedLiminaInputs;
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
  config: ResolvedLiminaInputs;
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
  config: ResolvedLiminaInputs;
  discovery: CheckerOwnershipDiscovery;
}): string[] {
  assertLockedDependencyFacts(options.discovery.plan);
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
  const declarationContexts = options.discovery.plan.declarationContexts ?? [];
  for (const decision of declarationContexts) {
    if (decision.selection.state !== 'selected') continue;
    const from = decision.consumerConfig;
    const to = decision.selection.config;
    if (graph.adjacency.has(from) && graph.adjacency.has(to))
      addEdge({
        graph,
        edge: {
          from,
          to,
          reason: `declaration context: ${decision.file.lexicalPath}`,
        },
      });
  }
  addImplicitReferenceEdges({ ...options, graph, problems });
  colorAllBuildComponents({ ...options, ...graph, problems });
  return problems;
}

function collectComponent(
  adjacency: ReadonlyMap<string, Set<string>>,
  start: string,
  visited: Set<string>,
): string[] {
  const component: string[] = [];
  const queue = [start];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    component.push(current);
    queue.push(...adjacency.get(current)!);
  }
  return component.sort(compareCodeUnits);
}

function addKnownColor(
  colors: Map<CheckerName, string[]>,
  checker: CheckerName | undefined,
  configPath: string,
): void {
  if (checker === undefined) return;
  const paths = colors.get(checker);
  if (paths === undefined) colors.set(checker, [configPath]);
  else paths.push(configPath);
}

function collectKnownColors(options: {
  component: readonly string[];
  discovery: CheckerOwnershipDiscovery;
}): Map<CheckerName, string[]> {
  const colors = new Map<CheckerName, string[]>();
  for (const configPath of options.component) {
    addKnownColor(
      colors,
      getKnownBuildColor(options.discovery.plan.typeConfigs.get(configPath)!),
      configPath,
    );
  }
  return colors;
}

function formatConflict(options: {
  component: readonly string[];
  config: ResolvedLiminaInputs;
  discovery: CheckerOwnershipDiscovery;
  edges: readonly ColoringEdge[];
}): string {
  const colors = collectKnownColors(options);
  const members = new Set(options.component);
  return [
    'Build checker ownership conflict:',
    ...[...colors]
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .flatMap(([checker, paths]) => [
        `  checker: ${checker}`,
        ...paths.map(
          (configPath) =>
            `    - ${toRelativePath(options.config.rootDir, configPath)}`,
        ),
      ]),
    '  declaration relations:',
    ...options.edges
      .filter((edge) => members.has(edge.from) && members.has(edge.to))
      .slice(0, 8)
      .map(
        (edge) =>
          `    - ${toRelativePath(options.config.rootDir, edge.from)} -> ${toRelativePath(options.config.rootDir, edge.to)} (${edge.reason})`,
      ),
    '  reason: one internal declaration reference component must use one identical build checker.',
    '  fix: align the named checker scopes or split the declaration boundary.',
  ].join('\n');
}

function getComponentChecker(
  known: ReadonlyMap<CheckerName, string[]>,
  fallback: CheckerName,
): CheckerName {
  return known.keys().next().value ?? fallback;
}

function createColorEvidence(
  checker: CheckerName,
  configPath: string,
  isInherited: boolean,
) {
  return {
    checker,
    configPath,
    detail: isInherited
      ? 'inherited the unique build checker in the declaration component'
      : 'ordinary TypeScript fallback for the declaration component',
    source: isInherited ? ('build-closure' as const) : ('fallback' as const),
  };
}

function applyComponentColor(options: {
  checker: CheckerName;
  config: ResolvedLiminaInputs;
  configPath: string;
  discovery: CheckerOwnershipDiscovery;
  inherited: boolean;
  problems: string[];
}): void {
  const state = options.discovery.plan.typeConfigs.get(options.configPath)!;
  if (state.localOwner.kind === 'resolved') return;
  const problem = addLocalCheckerRequirement({
    config: options.config,
    evidence: createColorEvidence(
      options.checker,
      options.configPath,
      options.inherited,
    ),
    state,
  });
  if (problem !== null) options.problems.push(problem);
}

function colorComponent(options: {
  component: readonly string[];
  config: ResolvedLiminaInputs;
  discovery: CheckerOwnershipDiscovery;
  edges: readonly ColoringEdge[];
  problems: string[];
}): void {
  const known = collectKnownColors(options);
  if (known.size > 1) {
    options.problems.push(formatConflict(options));
    return;
  }
  const checker = getComponentChecker(known, options.discovery.autoChecker);
  for (const configPath of options.component) {
    applyComponentColor({
      ...options,
      checker,
      configPath,
      inherited: known.size === 1,
    });
  }
}

function colorAllBuildComponents(options: {
  adjacency: ReadonlyMap<string, Set<string>>;
  config: ResolvedLiminaInputs;
  discovery: CheckerOwnershipDiscovery;
  edges: readonly ColoringEdge[];
  problems: string[];
}): void {
  const visited = new Set<string>();
  for (const configPath of options.adjacency
    .keys()
    .toArray()
    .sort(compareCodeUnits)) {
    if (visited.has(configPath)) continue;
    colorComponent({
      ...options,
      component: collectComponent(options.adjacency, configPath, visited),
    });
  }
}

function getKnownBuildColor(
  state: TypeConfigOwnershipState,
): CheckerName | undefined {
  return state.localOwner.kind === 'resolved'
    ? state.localOwner.checker
    : getUniqueConstraint(state);
}

function isBuildColoringCandidate(
  state: TypeConfigOwnershipState,
  isBuildChecker: (checker: CheckerName) => boolean,
): boolean {
  const checker = getKnownBuildColor(state);
  return checker === undefined || isBuildChecker(checker);
}
