import { resolveCheckerBuildConcurrency } from '../../execution/config';
import { runPool } from '../../execution/pool';
import type {
  CheckerTargetId,
  TypecheckTarget,
  TypecheckTargetResult,
} from '../targets';
import { runTargetWithMeasuredDuration } from '../targets';
import type {
  BuildRunState,
  RunBuildTargetsArgs,
  RunnableLayer,
} from './target-state';
import {
  createBuildRunState,
  createFailedTargetResult,
  createRunnableLayer,
  emitTargetResult,
  getComponentTargets,
} from './target-state';

export type {
  RunBuildTargetsArgs,
  RunBuildTargetsOptions,
} from './target-state';

function createLayerFailureResults(options: {
  error: unknown;
  state: BuildRunState;
  targets: readonly TypecheckTarget[];
}): TypecheckTargetResult[] {
  return options.targets.map((target) => {
    const result = createFailedTargetResult(target, options.error);
    emitTargetResult(options.state.options, target, result);
    return result;
  });
}

function shouldRunBeforeLayer(
  state: BuildRunState,
  targets: readonly TypecheckTarget[],
): boolean {
  return [targets.length > 0, state.options.beforeLayerRun !== undefined].every(
    Boolean,
  );
}

async function runBeforeLayer(
  state: BuildRunState,
  targets: readonly TypecheckTarget[],
): Promise<TypecheckTargetResult[]> {
  if (!shouldRunBeforeLayer(state, targets)) {
    return [];
  }

  try {
    await state.options.beforeLayerRun!(targets);
    return [];
  } catch (error) {
    return createLayerFailureResults({ error, state, targets });
  }
}

function resolveLayerConcurrency(
  state: BuildRunState,
  targets: readonly TypecheckTarget[],
): number {
  return state.options.watch === true
    ? targets.length
    : resolveCheckerBuildConcurrency({
        config: state.options.config,
        itemCount: targets.length,
      });
}

async function beforeTargetRun(
  state: BuildRunState,
  target: TypecheckTarget,
): Promise<void> {
  if (state.options.beforeTargetRun !== undefined) {
    await state.options.beforeTargetRun(target);
  }

  if (state.options.onTargetStart !== undefined) {
    state.options.onTargetStart(target);
  }
}

async function runRunnableTargets(
  state: BuildRunState,
  targets: readonly TypecheckTarget[],
): Promise<TypecheckTargetResult[]> {
  return runPool<TypecheckTarget, TypecheckTargetResult>({
    concurrency: resolveLayerConcurrency(state, targets),
    items: [...targets],
    onError: createFailedTargetResult,
    onResult: state.options.onTargetResult,
    run: async (target) => {
      await beforeTargetRun(state, target);
      return runTargetWithMeasuredDuration(state.runner, target);
    },
  });
}

function shouldRunTargets(
  targets: readonly TypecheckTarget[],
  layerResults: readonly TypecheckTargetResult[],
): boolean {
  return [targets.length > 0, layerResults.length === 0].every(Boolean);
}

async function executeRunnableLayer(
  state: BuildRunState,
  runnableLayer: RunnableLayer,
): Promise<TypecheckTargetResult[]> {
  const layerResults = await runBeforeLayer(state, runnableLayer.targets);

  return shouldRunTargets(runnableLayer.targets, layerResults)
    ? runRunnableTargets(state, runnableLayer.targets)
    : layerResults;
}

function recordLayerResults(
  state: BuildRunState,
  layerResults: readonly TypecheckTargetResult[],
): void {
  for (const result of layerResults) {
    state.resultsByTargetId.set(result.id, result);
  }
}

function isFailedTarget(
  resultsByTargetId: ReadonlyMap<CheckerTargetId, TypecheckTargetResult>,
  target: TypecheckTarget,
): boolean {
  return resultsByTargetId.get(target.id)?.status !== 0;
}

function updateComponentFailureRoots(
  state: BuildRunState,
  componentIndexes: readonly number[],
): void {
  for (const componentIndex of componentIndexes) {
    const failedRoots = getComponentTargets(state.buildPlan, componentIndex)
      .filter((target) => isFailedTarget(state.resultsByTargetId, target))
      .map((target) => target.id);
    state.failureRootsByComponentIndex.set(
      componentIndex,
      state.stableRoots(failedRoots),
    );
  }
}

async function executeLayer(
  state: BuildRunState,
  layer: readonly number[],
): Promise<void> {
  const runnableLayer = createRunnableLayer(state, layer);
  const layerResults = await executeRunnableLayer(state, runnableLayer);
  recordLayerResults(state, layerResults);
  updateComponentFailureRoots(state, runnableLayer.componentIndexes);
}

function requireTargetResult(
  resultsByTargetId: ReadonlyMap<CheckerTargetId, TypecheckTargetResult>,
  target: TypecheckTarget,
): TypecheckTargetResult {
  const result = resultsByTargetId.get(target.id);

  if (result === undefined) {
    throw new Error(`Missing checker target result for ${target.id}.`);
  }

  return result;
}

export async function executeBuildTargets(
  ...args: RunBuildTargetsArgs
): Promise<TypecheckTargetResult[]> {
  const [targets, dependencyEdges, runner, options] = args;
  const state = createBuildRunState({
    dependencyEdges,
    runner,
    runOptions: options,
    targets,
  });

  for (const layer of state.buildPlan.layers) {
    await executeLayer(state, layer);
  }

  return targets.map((target) =>
    requireTargetResult(state.resultsByTargetId, target),
  );
}
