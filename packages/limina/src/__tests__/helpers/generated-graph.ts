import type { ResolvedLiminaConfig } from '#config/runner';
import {
  type GeneratedTsconfigGraphResult,
  prepareGeneratedTsconfigGraph,
  type PrepareGeneratedTsconfigGraphOptions,
} from '#core/build-graph/runner';
import { materializeGeneratedArtifactPlan } from '../../core/build-graph/materializer';

/**
 * Test-only orchestration for assertions that inspect generated files.
 * Production planning remains side-effect free; tests opt into materialization.
 */
export async function prepareAndMaterializeGeneratedTsconfigGraph(
  config: ResolvedLiminaConfig,
  options: PrepareGeneratedTsconfigGraphOptions = {},
): Promise<GeneratedTsconfigGraphResult> {
  const result = await prepareGeneratedTsconfigGraph(config, options);
  await materializeGeneratedArtifactPlan(result.artifactPlan);
  return result;
}
