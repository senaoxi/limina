import type { ResolvedLiminaConfig } from '#config/runner';
import type { AnalysisMetricsRecorder } from '../application/analysis/analysis-run';
import { runKnipSourcePhase } from './knip/phase';
import { finishSourceCheckAnalysis, prepareSourceCheck } from './phases';
import type { RunSourceCheckImplOptions } from './runner-types';

export type { RunSourceCheckOptions } from './runner-types';

async function observePhase<T>(options: {
  kind: string;
  metrics: AnalysisMetricsRecorder | undefined;
  run(): Promise<T>;
}): Promise<T> {
  const start = performance.now();
  try {
    return await options.run();
  } finally {
    options.metrics?.record({
      name: 'source-phase',
      kind: options.kind,
      durationMs: performance.now() - start,
    });
  }
}

export async function runSourceCheckImpl(
  config: ResolvedLiminaConfig,
  options: RunSourceCheckImplOptions = {},
): Promise<boolean> {
  const metrics = options.preflight?.run.metrics;
  const state = await observePhase({
    kind: 'readonly-prepare',
    metrics,
    run: () => prepareSourceCheck(config, options),
  });
  await observePhase({
    kind: 'knip',
    metrics,
    run: () => runKnipSourcePhase(state),
  });
  return observePhase({
    kind: 'readonly-analysis',
    metrics,
    run: () => finishSourceCheckAnalysis(state),
  });
}
