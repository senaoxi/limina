import type { AnalysisMetricsRecorder } from '../../application/analysis/analysis-run';
import type { NativeAnalysisCache } from '../analysis-cache/native-cache';
import type {
  TypeScriptSemanticContext,
  TypeScriptSemanticDependencyContext,
  TypeScriptSemanticProject,
} from './contracts';
import { createNativeDependencyContext } from './native-context-factory';
import { createNativeSemanticContext } from './native-semantic-factory';
export type * from './contracts';
export {
  createTypeScriptProjectDependencyFactsIdentity,
  createTypeScriptSemanticContextIdentity,
} from './identity';
export { createTypeScriptSemanticDependencySnapshot } from './snapshot';
export {
  createWorkspaceSourceBoundary,
  createWorkspaceSourceBoundaryFromProjects,
} from './workspace-source-boundary';
export type { WorkspaceSourceBoundary } from './workspace-source-boundary';

export function createBoundedTypeScriptSemanticContext(
  project: TypeScriptSemanticProject,
  options: {
    metrics?: AnalysisMetricsRecorder;
    analysisCache?: NativeAnalysisCache;
  } = {},
): TypeScriptSemanticContext {
  return createNativeSemanticContext(
    project,
    options.analysisCache,
    options.metrics,
  );
}

/**
Native requests and physical frontier have one producer and no fallback.
*/
export function createTypeScriptDependencyContext(
  project: TypeScriptSemanticProject,
  options: {
    metrics?: AnalysisMetricsRecorder;
    analysisCache?: NativeAnalysisCache;
  } = {},
): TypeScriptSemanticDependencyContext & { dispose(): void } {
  return createNativeDependencyContext(
    project,
    options.analysisCache,
    options.metrics,
  );
}
