import type { ResolvedLiminaConfig } from '#config/runner';
import type { GeneratedDependencyEdge } from '#core/build-graph/runner';
import type {
  BuildTargetCompletion,
  CheckerTargetId,
  TypecheckRunner,
  TypecheckTarget,
  TypecheckTargetResult,
} from '../targets';
import type { BuildDependencyPlan } from './dependency-plan';
import { createBuildDependencyPlan } from './dependency-plan';

export interface RunBuildTargetsOptions {
  executionPrerequisites?: GeneratedDependencyEdge[];
  isDeliveryComplete?: (id: CheckerTargetId) => boolean;
  executeTarget?: (target: TypecheckTarget) => Promise<BuildTargetCompletion>;
  onTargetOutcome?: (
    target: TypecheckTarget,
    result: BuildTargetCompletion,
  ) => void;
  config: ResolvedLiminaConfig;
  onTargetResult?: (
    target: TypecheckTarget,
    result: TypecheckTargetResult,
  ) => void;
  onTargetStart?: (target: TypecheckTarget) => void;
  watch?: boolean;
}

export type RunBuildTargetsArguments = [
  targets: TypecheckTarget[],
  dependencyEdges: GeneratedDependencyEdge[],
  runner: TypecheckRunner,
  options: RunBuildTargetsOptions,
];

export interface BuildRunState {
  buildPlan: BuildDependencyPlan;
  options: RunBuildTargetsOptions;
  resultsByTargetId: Map<CheckerTargetId, BuildTargetCompletion>;
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
  executionPrerequisites?: GeneratedDependencyEdge[];
}): BuildDependencyPlan {
  return options.watch === true
    ? createWatchBuildPlan(options.targets)
    : createBuildDependencyPlan(
        options.targets,
        options.dependencyEdges,
        options.executionPrerequisites,
      );
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

function collectUpstreamRoots(
  state: BuildRunState,
  target: TypecheckTarget,
): CheckerTargetId[] {
  const prerequisites =
    state.buildPlan.executionDependenciesByTargetId?.get(target.id) ?? [];
  return state.stableRoots(
    prerequisites.flatMap((id) =>
      state.options.isDeliveryComplete?.(id) === false
        ? [id]
        : failureRoots(state.resultsByTargetId.get(id)),
    ),
  );
}
function failureRoots(
  result: BuildTargetCompletion | undefined,
): readonly CheckerTargetId[] {
  return result === undefined ? [] : failedRoots(result);
}
function failedRoots(
  result: BuildTargetCompletion,
): readonly CheckerTargetId[] {
  if (result.status === 0) return [];
  return result.status === 'blocked' ? result.blockedBy : [result.id];
}

export function emitTargetResult(
  options: RunBuildTargetsOptions,
  target: TypecheckTarget,
  result: BuildTargetCompletion,
): void {
  emitNonProcessOutcome(options, target, result);
  if (typeof result.status !== 'number') return;
  options.onTargetResult?.(target, result);
}

function createBlockedResult(
  target: TypecheckTarget,
  blockedBy: readonly CheckerTargetId[],
): BuildTargetCompletion {
  return { blockedBy, id: target.id, status: 'blocked' };
}

function classifyTarget(
  state: BuildRunState,
  target: TypecheckTarget,
  layer: RunnableLayer,
): void {
  const roots = collectUpstreamRoots(state, target);
  if (roots.length === 0 || state.options.watch === true) {
    layer.targets.push(target);
    return;
  }
  const result = createBlockedResult(target, roots);
  state.resultsByTargetId.set(target.id, result);
  emitTargetResult(state.options, target, result);
}
function classifyComponent(options: {
  componentIndex: number;
  runnableLayer: RunnableLayer;
  state: BuildRunState;
}): void {
  for (const target of getComponentTargets(
    options.state.buildPlan,
    options.componentIndex,
  ))
    classifyTarget(options.state, target, options.runnableLayer);
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
      executionPrerequisites: options.runOptions.executionPrerequisites,
    }),
    options: options.runOptions,
    resultsByTargetId: new Map(),
    runner: options.runner,
    stableRoots: createStableRootSorter(options.targets),
  };
}

function emitNonProcessOutcome(
  options: RunBuildTargetsOptions,
  target: TypecheckTarget,
  result: BuildTargetCompletion,
): void {
  options.onTargetOutcome?.(target, result);
}
