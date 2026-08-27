import type { ResolvedLiminaConfig } from '#config/runner';
import type { GeneratedDependencyEdge } from '#core/build-graph/runner';
import type {
  CheckerTargetId,
  TypecheckRunner,
  TypecheckTarget,
  TypecheckTargetResult,
} from '../targets';
import type { BuildDependencyPlan } from './dependency-plan';
import { createBuildDependencyPlan } from './dependency-plan';

export interface RunBuildTargetsOptions {
  beforeLayerRun?: (targets: readonly TypecheckTarget[]) => Promise<void>;
  beforeTargetRun?: (target: TypecheckTarget) => Promise<void>;
  config: ResolvedLiminaConfig;
  onTargetResult?: (
    target: TypecheckTarget,
    result: TypecheckTargetResult,
  ) => void;
  onTargetStart?: (target: TypecheckTarget) => void;
  watch?: boolean;
}

export type RunBuildTargetsArgs = [
  targets: TypecheckTarget[],
  dependencyEdges: GeneratedDependencyEdge[],
  runner: TypecheckRunner,
  options: RunBuildTargetsOptions,
];

export interface BuildRunState {
  buildPlan: BuildDependencyPlan;
  failureRootsByComponentIndex: Map<number, readonly CheckerTargetId[]>;
  options: RunBuildTargetsOptions;
  resultsByTargetId: Map<CheckerTargetId, TypecheckTargetResult>;
  runner: TypecheckRunner;
  stableRoots: (roots: Iterable<CheckerTargetId>) => CheckerTargetId[];
}

export interface RunnableLayer {
  componentIndexes: number[];
  targets: TypecheckTarget[];
}

function createWatchBuildPlan(targets: TypecheckTarget[]): BuildDependencyPlan {
  return {
    components: [targets],
    dependenciesByComponentIndex: new Map([[0, new Set<number>()]]),
    layers: [[0]],
  };
}

function resolveBuildPlan(options: {
  dependencyEdges: GeneratedDependencyEdge[];
  targets: TypecheckTarget[];
  watch: boolean | undefined;
}): BuildDependencyPlan {
  return options.watch === true
    ? createWatchBuildPlan(options.targets)
    : createBuildDependencyPlan(options.targets, options.dependencyEdges);
}

function getTargetOrder(
  targetOrderById: ReadonlyMap<CheckerTargetId, number>,
  targetId: CheckerTargetId,
): number {
  const order = targetOrderById.get(targetId);
  return order === undefined ? Number.MAX_SAFE_INTEGER : order;
}

function createStableRootSorter(
  targets: readonly TypecheckTarget[],
): (roots: Iterable<CheckerTargetId>) => CheckerTargetId[] {
  const targetOrderById = new Map(
    targets.map((target, index) => [target.id, index]),
  );

  return (roots) =>
    [...new Set(roots)].sort(
      (left, right) =>
        getTargetOrder(targetOrderById, left) -
        getTargetOrder(targetOrderById, right),
    );
}

export function getComponentTargets(
  buildPlan: BuildDependencyPlan,
  componentIndex: number,
): TypecheckTarget[] {
  const targets = buildPlan.components[componentIndex];
  return targets === undefined ? [] : targets;
}

function getComponentDependencies(
  buildPlan: BuildDependencyPlan,
  componentIndex: number,
): readonly number[] {
  const dependencies =
    buildPlan.dependenciesByComponentIndex.get(componentIndex);
  return dependencies === undefined ? [] : [...dependencies];
}

function collectUpstreamRoots(
  state: BuildRunState,
  componentIndex: number,
): CheckerTargetId[] {
  const roots = getComponentDependencies(
    state.buildPlan,
    componentIndex,
  ).flatMap(
    (dependencyIndex) =>
      state.failureRootsByComponentIndex.get(dependencyIndex) ?? [],
  );
  return state.stableRoots(roots);
}

export function emitTargetResult(
  options: RunBuildTargetsOptions,
  target: TypecheckTarget,
  result: TypecheckTargetResult,
): void {
  if (options.onTargetResult !== undefined) {
    options.onTargetResult(target, result);
  }
}

function createBlockedResult(
  target: TypecheckTarget,
  blockedBy: readonly CheckerTargetId[],
): TypecheckTargetResult {
  return {
    blockedBy,
    configPath: target.configPath,
    durationMs: 0,
    id: target.id,
    status: 1,
  };
}

function blockComponent(options: {
  componentIndex: number;
  componentTargets: readonly TypecheckTarget[];
  state: BuildRunState;
  upstreamRoots: readonly CheckerTargetId[];
}): void {
  options.state.failureRootsByComponentIndex.set(
    options.componentIndex,
    options.upstreamRoots,
  );

  for (const target of options.componentTargets) {
    const result = createBlockedResult(target, options.upstreamRoots);
    options.state.resultsByTargetId.set(target.id, result);
    emitTargetResult(options.state.options, target, result);
  }
}

function isRunnableComponent(
  upstreamRoots: readonly CheckerTargetId[],
  watch: boolean | undefined,
): boolean {
  return [upstreamRoots.length === 0, watch === true].some(Boolean);
}

function classifyComponent(options: {
  componentIndex: number;
  runnableLayer: RunnableLayer;
  state: BuildRunState;
}): void {
  const componentTargets = getComponentTargets(
    options.state.buildPlan,
    options.componentIndex,
  );
  const upstreamRoots = collectUpstreamRoots(
    options.state,
    options.componentIndex,
  );

  if (isRunnableComponent(upstreamRoots, options.state.options.watch)) {
    options.runnableLayer.componentIndexes.push(options.componentIndex);
    options.runnableLayer.targets.push(...componentTargets);
    return;
  }

  blockComponent({
    componentIndex: options.componentIndex,
    componentTargets,
    state: options.state,
    upstreamRoots,
  });
}

export function createRunnableLayer(
  state: BuildRunState,
  layer: readonly number[],
): RunnableLayer {
  const runnableLayer: RunnableLayer = { componentIndexes: [], targets: [] };

  for (const componentIndex of layer) {
    classifyComponent({ componentIndex, runnableLayer, state });
  }

  return runnableLayer;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function createFailedTargetResult(
  target: TypecheckTarget,
  error: unknown,
): TypecheckTargetResult {
  return {
    configPath: target.configPath,
    durationMs: 0,
    error: toError(error),
    id: target.id,
    status: 1,
  };
}

export function createBuildRunState(options: {
  dependencyEdges: GeneratedDependencyEdge[];
  runner: TypecheckRunner;
  runOptions: RunBuildTargetsOptions;
  targets: TypecheckTarget[];
}): BuildRunState {
  return {
    buildPlan: resolveBuildPlan({
      dependencyEdges: options.dependencyEdges,
      targets: options.targets,
      watch: options.runOptions.watch,
    }),
    failureRootsByComponentIndex: new Map(),
    options: options.runOptions,
    resultsByTargetId: new Map(),
    runner: options.runner,
    stableRoots: createStableRootSorter(options.targets),
  };
}
