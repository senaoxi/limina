import type { AnalysisMetricsRecorder } from '../../application/analysis/analysis-run';
import { captureBoundedContext } from '../analysis-cache/bounded-context-capture';
import { EpochInputs } from '../analysis-cache/epoch-inputs';
import type { NativeAnalysisCache } from '../analysis-cache/native-cache';
import type {
  TypeScriptSemanticContext,
  TypeScriptSemanticProject,
} from './contracts';
import { nativeContextInputs } from './native-context-inputs';
import { NativeSemanticContext } from './native-semantic-context';

export function createNativeSemanticContext(
  project: TypeScriptSemanticProject,
  cache?: NativeAnalysisCache,
  metrics?: AnalysisMetricsRecorder,
): TypeScriptSemanticContext {
  const reads = new EpochInputs();
  const result = reads.collect(() => {
    const input = {
      ...nativeContextInputs(
        { ...project, admissionMode: 'coverage-bounded' },
        cache,
      ),
      metrics,
      profileRole: 'type-evidence' as const,
    };
    cache?.recordProgram();
    return {
      input,
      context: new NativeSemanticContext(
        input,
        cache === undefined
          ? undefined
          : (file, text, sourceFile) =>
              cache.readFileSyntax(
                file,
                text,
                input.queries && input.project,
                sourceFile,
              ),
      ),
    };
  });
  if (cache && result.input.queries)
    captureBoundedContext({
      context: result.context,
      project: result.input.project,
      cache,
      queryIds: result.input.queries.ids,
      discovery: reads.snapshot(),
    });
  return result.context;
}
