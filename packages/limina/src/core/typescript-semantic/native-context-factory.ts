import ts from 'typescript';
import type { AnalysisMetricsRecorder } from '../../application/analysis/analysis-run';
import { captureBoundedContext } from '../analysis-cache/bounded-context-capture';
import { EpochInputs } from '../analysis-cache/epoch-inputs';
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
  if (cache?.supports(input.project, ts))
    captureBoundedContext({
      project: input.project,
      context,
      cache,
      discovery: reads.snapshot(),
    });
  return context;
}

function collectBoundedContext(
  project: TypeScriptSemanticProject,
  cache: NativeAnalysisCache | undefined,
  metrics: AnalysisMetricsRecorder | undefined,
) {
  const input = {
    ...nativeContextInputs({
      ...project,
      admissionMode: 'coverage-bounded',
    }),
    metrics,
  };
  try {
    cache?.recordProgram();
    return { input, context: new NativeDependencyContext(input) };
  } catch (error) {
    return { input, context: failedNativeDependencyContext(input, error) };
  }
}
