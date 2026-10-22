import type { BuildTargetCompletion } from '../targets';
import {
  executeBuildTargets,
  type RunBuildTargetsArgs as RunBuildTargetsArguments,
} from './target-execution';

export type { RunBuildTargetsOptions } from './target-execution';

export async function runBuildTargets(
  ...arguments_: RunBuildTargetsArguments
): Promise<BuildTargetCompletion[]> {
  return executeBuildTargets(...arguments_);
}
