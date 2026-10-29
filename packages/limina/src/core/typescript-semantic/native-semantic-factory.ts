import ts from 'typescript';
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
      ...nativeContextInputs({
        ...project,
        admissionMode: 'coverage-bounded',
      }),
      metrics,
    };
    cache?.recordProgram();
    return {
      input,
      context: new NativeSemanticContext(
        input,
        cache === undefined
          ? undefined
          : (file, text) => cache.readFileSyntax(file, text),
      ),
    };
  });
  if (cache?.supports(result.input.project, ts))
    captureBoundedContext({
      context: result.context,
      project: result.input.project,
      cache,
      discovery: reads.snapshot(),
    });
  return result.context;
}
