import type { CheckerName, ResolvedLiminaConfig } from '#config/runner';
import { compareCodeUnits } from '#utils/collections';
import { toRelativePath } from '#utils/path';
import type { ColoringEdge } from './checker-build-coloring';
import { getKnownBuildColor } from './checker-build-coloring-state';
import type { CheckerOwnershipDiscovery } from './checker-ownership-discovery';
import { addLocalCheckerRequirement } from './checker-ownership-evidence';

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
  config: ResolvedLiminaConfig;
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
  inherited: boolean,
) {
  return {
    checker,
    configPath,
    detail: inherited
      ? 'inherited the unique build checker in the declaration component'
      : 'ordinary TypeScript fallback for the declaration component',
    source: inherited ? ('build-closure' as const) : ('fallback' as const),
  };
}

function applyComponentColor(options: {
  checker: CheckerName;
  config: ResolvedLiminaConfig;
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
  config: ResolvedLiminaConfig;
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

export function colorAllBuildComponents(options: {
  adjacency: ReadonlyMap<string, Set<string>>;
  config: ResolvedLiminaConfig;
  discovery: CheckerOwnershipDiscovery;
  edges: readonly ColoringEdge[];
  problems: string[];
}): void {
  const visited = new Set<string>();
  for (const configPath of [...options.adjacency.keys()].sort(
    compareCodeUnits,
  )) {
    if (visited.has(configPath)) continue;
    colorComponent({
      ...options,
      component: collectComponent(options.adjacency, configPath, visited),
    });
  }
}
