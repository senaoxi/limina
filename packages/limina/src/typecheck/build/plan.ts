import type { TypecheckTargetResult } from '../targets';
import {
  executeBuildTargets,
  type RunBuildTargetsArgs,
} from './target-execution';

export type { RunBuildTargetsOptions } from './target-execution';

export async function runBuildTargets(
  ...args: RunBuildTargetsArgs
): Promise<TypecheckTargetResult[]> {
  return executeBuildTargets(...args);
}
