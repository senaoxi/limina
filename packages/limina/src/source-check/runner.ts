import type { ResolvedLiminaConfig } from '#config/runner';
import { runKnipSourcePhase } from './knip/phase';
import { isFinishSourceCheckAnalysis, prepareSourceCheck } from './phases';
import type { RunSourceCheckImplOptions } from './runner-types';

export type { RunSourceCheckOptions } from './runner-types';

export async function isRunSourceCheckImpl(
  config: ResolvedLiminaConfig,
  options: RunSourceCheckImplOptions = {},
): Promise<boolean> {
  const state = await prepareSourceCheck(config, options);
  await runKnipSourcePhase(state);
  return isFinishSourceCheckAnalysis(state);
}
