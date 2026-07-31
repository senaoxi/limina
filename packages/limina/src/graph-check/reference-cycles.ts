import type { ResolvedLiminaConfig } from '#config/runner';
import {
  isDtsProjectConfig,
  type ProjectInfo,
} from '#core/import-graph/context';
import { compareCodeUnits } from '#utils/collections';
import { toRelativePath } from '#utils/path';
import { collectStronglyConnectedComponents } from '#utils/strongly-connected-components';
import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import type { CheckCounter } from '../check-reporting/stats';
import { getProjectCheckerName } from './finding-utils';
import type { GraphFinding, GraphReferenceCycleFinding } from './findings';

const GENERATED_REFERENCE_CYCLE_REASON =
  'Generated declaration project references must be acyclic so build-mode checkers can order declaration builds.';
const GENERATED_REFERENCE_CYCLE_FIX =
  'Break the cycle by merging tightly coupled source scopes, extracting shared contracts, moving runtime wiring to a higher-level entry, or using an intentional declaration boundary.';

interface GeneratedReferenceCycleEdge {
  from: string;
  to: string;
}

function createGeneratedReferenceGraph(
  projects: ProjectInfo[],
): Map<string, Set<string>> {
  const dtsProjects = projects.filter((project) =>
    isDtsProjectConfig(project.configPath),
  );
  const dtsProjectPaths = new Set(
    dtsProjects.map((project) => project.configPath),
  );
  const graph = new Map<string, Set<string>>();

  for (const project of dtsProjects) {
    const references = [...project.references]
      .filter((referencePath) => dtsProjectPaths.has(referencePath))
      .sort();

    graph.set(project.configPath, new Set(references));
  }

  return graph;
}

function collectGeneratedReferenceComponents(
  graph: Map<string, Set<string>>,
): string[][] {
  const configPaths = new Set(graph.keys());

  for (const referencePaths of graph.values()) {
    for (const referencePath of referencePaths) {
      configPaths.add(referencePath);
    }
  }

  return collectStronglyConnectedComponents(
    [...configPaths].sort(),
    (configPath) => graph.get(configPath) ?? [],
  );
}

function getGeneratedReferenceCycleEdges(
  graph: Map<string, Set<string>>,
  members: string[],
): GeneratedReferenceCycleEdge[] {
  const memberPaths = new Set(members);

  return members
    .flatMap((from) =>
      [...(graph.get(from) ?? [])]
        .filter((to) => memberPaths.has(to))
        .map((to) => ({ from, to })),
    )
    .sort(
      (left, right) =>
        compareCodeUnits(left.from, right.from) ||
        compareCodeUnits(left.to, right.to),
    );
}

function hasSelfReference(
  graph: Map<string, Set<string>>,
  member: string | undefined,
): boolean {
  if (!member) {
    return false;
  }

  const references = graph.get(member);
  if (!references) {
    return false;
  }

  return references.has(member);
}

function isCycleComponent(
  graph: Map<string, Set<string>>,
  component: string[],
): boolean {
  if (component.length > 1) {
    return true;
  }

  return hasSelfReference(graph, component[0]);
}

function getSingleCheckerName(
  members: string[],
  checkerNamesByPath: ReadonlyMap<string, string>,
): string | undefined {
  const checkerNames = new Set(
    members
      .map((member) => getProjectCheckerName(checkerNamesByPath, member))
      .filter((value): value is string => Boolean(value)),
  );

  if (checkerNames.size !== 1) {
    return undefined;
  }

  return [...checkerNames][0];
}

function createCycleFinding(options: {
  config: ResolvedLiminaConfig;
  edges: GeneratedReferenceCycleEdge[];
  members: string[];
  projectCheckerNamesByPath: ReadonlyMap<string, string>;
}): GraphReferenceCycleFinding {
  const detailLines = [
    'Generated project reference cycle:',
    '  projects:',
    ...options.members.map(
      (member) => `    - ${toRelativePath(options.config.rootDir, member)}`,
    ),
    '  references in cycle:',
    ...options.edges.map(
      (edge) =>
        `    - ${toRelativePath(options.config.rootDir, edge.from)} -> ${toRelativePath(options.config.rootDir, edge.to)}`,
    ),
    `  reason: ${GENERATED_REFERENCE_CYCLE_REASON}`,
    `  fix: ${GENERATED_REFERENCE_CYCLE_FIX}`,
  ];

  return {
    checkerName: getSingleCheckerName(
      options.members,
      options.projectCheckerNamesByPath,
    ),
    code: LIMINA_CHECK_ISSUE_CODES.graphReferenceCycle,
    evidence: [
      { label: 'projects', lines: options.members },
      {
        label: 'references in cycle',
        lines: options.edges.map((edge) => `${edge.from} -> ${edge.to}`),
      },
    ],
    facts: {
      edges: options.edges,
      projectPaths: options.members,
    },
    filePath: options.members[0],
    locations: options.members.map((member) => ({
      filePath: member,
      label: 'cycle project',
    })),
    presentation: {
      detailLines,
      fix: GENERATED_REFERENCE_CYCLE_FIX,
      reason: GENERATED_REFERENCE_CYCLE_REASON,
      title: 'Generated project reference cycle',
    },
    task: 'graph:check',
  };
}

export function addGeneratedReferenceCycleProblems(options: {
  checks: CheckCounter;
  config: ResolvedLiminaConfig;
  findings: GraphFinding[];
  projectCheckerNamesByPath: ReadonlyMap<string, string>;
  projects: ProjectInfo[];
}): void {
  const graph = createGeneratedReferenceGraph(options.projects);

  options.checks.add(graph.size);
  for (const component of collectGeneratedReferenceComponents(graph)) {
    if (!isCycleComponent(graph, component)) {
      continue;
    }

    const members = [...component].sort();
    options.findings.push(
      createCycleFinding({
        config: options.config,
        edges: getGeneratedReferenceCycleEdges(graph, members),
        members,
        projectCheckerNamesByPath: options.projectCheckerNamesByPath,
      }),
    );
  }
}
