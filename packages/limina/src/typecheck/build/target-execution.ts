import { resolveCheckerBuildConcurrency } from '../../execution/config';
import { runPool } from '../../execution/pool';
import { rejectedBeforeLaunch } from '../admission/reporting';
import type {
  BuildTargetCompletion,
  CheckerTargetId,
  TypecheckTarget,
} from '../targets';
import { runTargetWithMeasuredDuration } from '../targets';
import type { BuildRunState, RunBuildTargetsArguments } from './target-state';
import {
  createBuildRunState,
  createFailedTargetResult,
  createRunnableLayer,
  emitTargetResult,
} from './target-state';

export type {
  RunBuildTargetsArguments as RunBuildTargetsArgs,
  RunBuildTargetsOptions,
} from './target-state';

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
): Promise<BuildTargetCompletion | undefined> {
  try {
    state.options.onTargetStart?.(target);
    return undefined;
  } catch (error) {
    return rejectedBeforeLaunch(target, error);
  }
}

async function runRunnableTargets(
  state: BuildRunState,
  targets: readonly TypecheckTarget[],
): Promise<BuildTargetCompletion[]> {
  if (targets.length === 0) return [];
  return runPool<TypecheckTarget, BuildTargetCompletion>({
    concurrency: resolveLayerConcurrency(state, targets),
    items: [...targets],
    onError: createFailedTargetResult,
    onResult: (target, result) =>
      emitTargetResult(state.options, target, result),
    run: async (target) => {
      const refusal = await beforeTargetRun(state, target);
      if (refusal !== undefined) return refusal;
      return state.options.executeTarget === undefined
        ? runTargetWithMeasuredDuration(state.runner, target)
        : state.options.executeTarget(target);
    },
  });
}

function recordLayerResults(
  state: BuildRunState,
  layerResults: readonly BuildTargetCompletion[],
): void {
  for (const result of layerResults) {
    state.resultsByTargetId.set(result.id, result);
  }
}

async function executeLayer(
  state: BuildRunState,
  layer: readonly number[],
): Promise<void> {
  const runnableLayer = createRunnableLayer(state, layer);
  const layerResults = await runRunnableTargets(state, runnableLayer.targets);
  recordLayerResults(state, layerResults);
}

function requireTargetResult(
  resultsByTargetId: ReadonlyMap<CheckerTargetId, BuildTargetCompletion>,
  target: TypecheckTarget,
): BuildTargetCompletion {
  const result = resultsByTargetId.get(target.id);

  if (result === undefined) {
    throw new Error(`Missing checker target result for ${target.id}.`);
  }

  return result;
}

export async function executeBuildTargets(
  ...arguments_: RunBuildTargetsArguments
): Promise<BuildTargetCompletion[]> {
  const [targets, dependencyEdges, runner, options] = arguments_;
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
