import { resolveCheckerBuildConcurrency } from '../../execution/config';
import { rejectedBeforeLaunch } from '../admission/reporting';
import type {
  BuildTargetCompletion,
  CheckerTargetId,
  TypecheckTarget,
} from '../targets';
import { runTargetWithMeasuredDuration } from '../targets';
import { runComponentTargets } from './component-execution';
import type { BuildRunState, RunBuildTargetsArguments } from './target-state';
import {
  createBuildRunState,
  createFailedTargetResult,
  createRunnableComponent,
  emitTargetResult,
} from './target-state';

export type { RunBuildTargetsOptions } from './target-state';

function resolveTargetConcurrency(
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

async function executeTarget(
  state: BuildRunState,
  target: TypecheckTarget,
): Promise<void> {
  let result: BuildTargetCompletion;
  try {
    const refusal = await beforeTargetRun(state, target);
    result =
      refusal ??
      (await (state.options.executeTarget === undefined
        ? runTargetWithMeasuredDuration(state.runner, target)
        : state.options.executeTarget(target)));
  } catch (error) {
    result = createFailedTargetResult(target, error);
  }
  state.resultsByTargetId.set(target.id, result);
  emitTargetResult(state.options, target, result);
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

export async function runBuildTargets(
  ...arguments_: RunBuildTargetsArguments
): Promise<BuildTargetCompletion[]> {
  const [targets, dependencyEdges, runner, options] = arguments_;
  const state = createBuildRunState({
    dependencyEdges,
    runner,
    runOptions: options,
    targets,
  });

  await runComponentTargets({
    concurrency: resolveTargetConcurrency(state, targets),
    plan: state.buildPlan,
    prepareComponent: (index) => createRunnableComponent(state, index),
    run: (target) => executeTarget(state, target),
  });

  return targets.map((target) =>
    requireTargetResult(state.resultsByTargetId, target),
  );
}
