import type { AnalysisMetricsRecorder } from '../../application/analysis/analysis-run';
import { captureBoundedContext } from '../analysis-cache/bounded-context-capture';
import { EpochInputs } from '../analysis-cache/epoch-inputs';
import { retainContextExecutionInputs } from '../analysis-cache/execution-inputs';
import type { NativeAnalysisCache } from '../analysis-cache/native-cache';
import type {
  TypeScriptSemanticDependencyContext,
  TypeScriptSemanticProject,
} from './contracts';
import { failedNativeDependencyContext } from './native-context-failure';
import { nativeContextInputs } from './native-context-inputs';
import { NativeDependencyContext } from './native-dependency-context';

/**
Candidate factory; the migration gate owns selection of the production entry.
*/
export function createNativeDependencyContext(
  project: TypeScriptSemanticProject,
  cache?: NativeAnalysisCache,
  metrics?: AnalysisMetricsRecorder,
): TypeScriptSemanticDependencyContext & { dispose(): void } {
  const reads = new EpochInputs();
  const { input, context } = reads.collect(() =>
    collectBoundedContext(project, cache, metrics),
  );
  if (cache && input.queries)
    captureBoundedContext({
      project: input.project,
      context,
      cache,
      queryIds: input.queries.ids,
      discovery: reads.snapshot(),
    });
  retainContextExecutionInputs(
    context.nativeEvidence,
    project.configPath,
    reads,
    cache && input.queries && { cache, ids: input.queries.ids },
  );
  return context;
}

function collectBoundedContext(
  project: TypeScriptSemanticProject,
  cache: NativeAnalysisCache | undefined,
  metrics: AnalysisMetricsRecorder | undefined,
) {
  const input = {
    ...nativeContextInputs(
      { ...project, admissionMode: 'coverage-bounded' },
      cache,
    ),
    metrics,
  };
  try {
    if (cache !== undefined)
      metrics?.record({
        name: 'analysis-cache',
        kind: 'context-rebuilt',
        provider: 'typescript',
        context: project.configPath,
        count: 1,
      });
    cache?.recordProgram();
    return {
      input,
      context: new NativeDependencyContext(
        input,
        undefined,
        cache === undefined
          ? undefined
          : (file, text) =>
              cache.readFileSyntax(file, text, input.queries && input.project),
      ),
    };
  } catch (error) {
    return { input, context: failedNativeDependencyContext(input, error) };
  }
}
