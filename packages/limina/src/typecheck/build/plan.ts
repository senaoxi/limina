import type { TypecheckTargetResult } from '../targets';
import {
  executeBuildTargets,
  type RunBuildTargetsArgs as RunBuildTargetsArguments,
} from './target-execution';

export type { RunBuildTargetsOptions } from './target-execution';

export async function runBuildTargets(
  ...arguments_: RunBuildTargetsArguments
): Promise<TypecheckTargetResult[]> {
  return executeBuildTargets(...arguments_);
}
