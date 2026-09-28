import type { ResolvedLiminaConfig } from '#config/runner';
import {
  type GeneratedTsconfigGraphResult,
  prepareGeneratedTsconfigGraph,
  type PrepareGeneratedTsconfigGraphOptions,
} from '#core/build-graph/runner';
import { materializeGeneratedArtifactPlan } from '../../core/build-graph/materializer';
import { createLiminaArtifactNamespace } from '../../domain/artifacts/namespace';

/**
 * Test-only orchestration for assertions that inspect generated files.
 * Production planning remains side-effect free; tests opt into materialization.
 */
export async function prepareAndMaterializeGeneratedTsconfigGraph(
  config: ResolvedLiminaConfig,
  options: Omit<PrepareGeneratedTsconfigGraphOptions, 'artifactNamespace'> = {},
): Promise<GeneratedTsconfigGraphResult> {
  const artifactNamespace = createLiminaArtifactNamespace({
    generation: 0,
    rootDir: config.rootDir,
  });
  const result = await prepareGeneratedTsconfigGraph(config, {
    ...options,
    artifactNamespace,
  });
  await materializeGeneratedArtifactPlan(
    artifactNamespace,
    result.artifactPlan,
  );
  return result;
}
