import type { CheckerName } from '#config/runner';
import { compareCodeUnits } from '#utils/collections';
import { toRelativePath } from '#utils/path';
import type {
  CheckerEvidence,
  CheckerOwnershipPlan,
  SolutionOwnershipState,
  TypeConfigOwnershipState,
} from './checker-ownership-types';

type ConstraintNode =
  | { kind: 'solution'; path: string }
  | { kind: 'type'; path: string };

interface ConstraintSeed {
  checker: CheckerName;
  evidence: CheckerEvidence;
  node: ConstraintNode;
}

function nodeKey(node: ConstraintNode): string {
  return `${node.kind}\0${node.path}`;
}

function getCandidates(
  plan: CheckerOwnershipPlan,
  node: ConstraintNode,
): Map<CheckerName, CheckerEvidence[]> {
  const state =
    node.kind === 'solution'
      ? plan.solutions.get(node.path)
      : plan.typeConfigs.get(node.path);
  if (state === undefined) {
    throw new Error(`Missing checker constraint node ${node.path}.`);
  }
  return state.constraintCandidates;
}

function clearCandidates(plan: CheckerOwnershipPlan): void {
  for (const state of plan.solutions.values()) {
    state.constraintCandidates.clear();
  }
  for (const state of plan.typeConfigs.values()) {
    state.constraintCandidates.clear();
  }
}

function createDeclaredSeed(
  state: SolutionOwnershipState,
): ConstraintSeed | null {
  const checker = state.declaredConstraint;
  if (checker === undefined) return null;
  return {
    checker,
    evidence: {
      checker,
      configPath: state.configPath,
      detail: 'explicit named checker selected this solution entry',
      source: 'explicit',
    },
    node: { kind: 'solution', path: state.configPath },
  };
}

function createLocalSeed(
  state: TypeConfigOwnershipState,
): ConstraintSeed | null {
  const checker = getLocalSeedChecker(state);
  if (checker === undefined) return null;
  return {
    checker,
    evidence: getLocalSeedEvidence(state, checker),
    node: { kind: 'type', path: state.configPath },
  };
}

function getLocalSeedChecker(
  state: TypeConfigOwnershipState,
): CheckerName | undefined {
  if (state.localOwner.kind === 'resolved') return state.localOwner.checker;
  return state.finalOwner;
}

function getLocalSeedEvidence(
  state: TypeConfigOwnershipState,
  checker: CheckerName,
): CheckerEvidence {
  const evidence = state.evidence.find((entry) => entry.checker === checker);
  if (evidence !== undefined) return evidence;
  return {
    checker,
    configPath: state.configPath,
    detail: 'resolved local checker owner',
    source: 'config',
  };
}

function collectSeeds(plan: CheckerOwnershipPlan): ConstraintSeed[] {
  return [
    ...[...plan.solutions.values()].flatMap((state) => {
      const seed = createDeclaredSeed(state);
      return seed === null ? [] : [seed];
    }),
    ...[...plan.typeConfigs.values()].flatMap((state) => {
      const seed = createLocalSeed(state);
      return seed === null ? [] : [seed];
    }),
  ];
}

function createContainingSolutions(
  solutions: ReadonlyMap<string, SolutionOwnershipState>,
): Map<string, string[]> {
  const containing = new Map<string, string[]>();
  for (const solution of solutions.values()) {
    for (const leafPath of solution.leafConfigPaths) {
      addContainingSolution(containing, leafPath, solution.configPath);
    }
  }
  sortContainingSolutions(containing);
  return containing;
}

function addContainingSolution(
  containing: Map<string, string[]>,
  leafPath: string,
  solutionPath: string,
): void {
  const values = containing.get(leafPath);
  if (values === undefined) {
    containing.set(leafPath, [solutionPath]);
    return;
  }
  values.push(solutionPath);
}

function sortContainingSolutions(containing: Map<string, string[]>): void {
  for (const values of containing.values()) values.sort(compareCodeUnits);
}

function getSolutionNeighbors(
  plan: CheckerOwnershipPlan,
  path: string,
): ConstraintNode[] {
  const state = plan.solutions.get(path);
  if (state === undefined) return [];
  return state.leafConfigPaths.map((leafPath) => ({
    kind: 'type',
    path: leafPath,
  }));
}

function getTypeNeighbors(
  containingSolutions: ReadonlyMap<string, string[]>,
  path: string,
): ConstraintNode[] {
  const solutions = containingSolutions.get(path);
  if (solutions === undefined) return [];
  return solutions.map((solutionPath) => ({
    kind: 'solution',
    path: solutionPath,
  }));
}

function getNeighbors(options: {
  containingSolutions: ReadonlyMap<string, string[]>;
  node: ConstraintNode;
  plan: CheckerOwnershipPlan;
}): ConstraintNode[] {
  if (options.node.kind === 'solution') {
    return getSolutionNeighbors(options.plan, options.node.path);
  }
  return getTypeNeighbors(options.containingSolutions, options.node.path);
}

function addCandidate(options: {
  checker: CheckerName;
  evidence: CheckerEvidence;
  node: ConstraintNode;
  plan: CheckerOwnershipPlan;
}): boolean {
  const candidates = getCandidates(options.plan, options.node);
  const values = candidates.get(options.checker) ?? [];
  if (
    values.some(
      (entry) =>
        entry.configPath === options.evidence.configPath &&
        entry.detail === options.evidence.detail &&
        entry.source === options.evidence.source,
    )
  ) {
    return false;
  }
  values.push({ ...options.evidence });
  candidates.set(options.checker, values);
  return values.length === 1;
}

function processConstraintSeed(options: {
  containingSolutions: ReadonlyMap<string, string[]>;
  current: ConstraintSeed;
  plan: CheckerOwnershipPlan;
  queue: ConstraintSeed[];
  visited: Set<string>;
}): void {
  const identity = `${nodeKey(options.current.node)}\0${options.current.checker}`;
  addCandidate({ ...options.current, plan: options.plan });
  if (options.visited.has(identity)) return;
  options.visited.add(identity);
  for (const neighbor of getNeighbors({
    containingSolutions: options.containingSolutions,
    node: options.current.node,
    plan: options.plan,
  })) {
    options.queue.push({ ...options.current, node: neighbor });
  }
}

function propagate(plan: CheckerOwnershipPlan): void {
  const containingSolutions = createContainingSolutions(plan.solutions);
  const queue = collectSeeds(plan);
  const visited = new Set<string>();
  while (queue.length > 0) {
    processConstraintSeed({
      containingSolutions,
      current: queue.shift()!,
      plan,
      queue,
      visited,
    });
  }
}

function formatCandidateEvidence(
  candidates: ReadonlyMap<CheckerName, CheckerEvidence[]>,
  rootDir: string,
): string[] {
  return [...candidates]
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .flatMap(([checker, evidence]) => [
      `  checker: ${checker}`,
      ...evidence
        .slice(0, 3)
        .map(
          (entry) =>
            `    evidence: ${entry.source} at ${toRelativePath(rootDir, entry.configPath)} (${entry.detail})`,
        ),
    ]);
}

function collectStateProblems(options: {
  configPath: string;
  candidates: ReadonlyMap<CheckerName, CheckerEvidence[]>;
  kind: 'solution' | 'type config';
  rootDir: string;
}): string[] {
  if (options.candidates.size <= 1) return [];
  return [
    [
      'Checker ownership conflict:',
      `  ${options.kind}: ${toRelativePath(options.rootDir, options.configPath)}`,
      ...formatCandidateEvidence(options.candidates, options.rootDir),
      '  reason: one checker constraint domain contains multiple checker owners.',
    ].join('\n'),
  ];
}

export function propagateSolutionConstraints(options: {
  plan: CheckerOwnershipPlan;
  rootDir: string;
}): string[] {
  clearCandidates(options.plan);
  propagate(options.plan);
  return [
    ...[...options.plan.solutions.values()].flatMap((state) =>
      collectStateProblems({
        candidates: state.constraintCandidates,
        configPath: state.configPath,
        kind: 'solution',
        rootDir: options.rootDir,
      }),
    ),
    ...[...options.plan.typeConfigs.values()].flatMap((state) =>
      collectStateProblems({
        candidates: state.constraintCandidates,
        configPath: state.configPath,
        kind: 'type config',
        rootDir: options.rootDir,
      }),
    ),
  ];
}

export function getUniqueConstraint(
  state: Pick<TypeConfigOwnershipState, 'constraintCandidates'>,
): CheckerName | undefined {
  if (state.constraintCandidates.size !== 1) return undefined;
  return state.constraintCandidates.keys().next().value;
}
