import type { AnalysisMetricsRecorder } from '../../application/analysis/analysis-run';
import {
  type DeclarationValidationTarget,
  validateDeclarationContexts,
} from './declaration-context-validation';
import type { GeneratedGraphPreparationState } from './prepare-state';

export function validateStagedDeclarationContexts(
  state: GeneratedGraphPreparationState,
  metrics?: AnalysisMetricsRecorder,
): void {
  const targets: DeclarationValidationTarget[] = [];
  for (const projects of state.projectsByChecker.values())
    for (const project of projects)
      targets.push({
        sourceConfig: project.configPath,
        generatedConfig: project.dtsConfigPath,
        checker: project.checkerName,
        executionRoot:
          project.context.vueSemanticIdentity?.projectRootDir ??
          state.writeContext.rootDir,
        preset: project.checkerName,
      });
  for (const projects of state.outputProjectsByChecker.values())
    for (const project of projects)
      targets.push({
        sourceConfig: project.configPath,
        generatedConfig: project.outputConfigPath,
        checker: project.checkerName,
        executionRoot:
          project.context.vueSemanticIdentity?.projectRootDir ??
          state.writeContext.rootDir,
        preset: project.checkerName,
      });
  validateDeclarationContexts({
    analysis: state.dependencyAnalysis,
    dependencyEdges: state.dependencyEdges,
    files: state.writeContext.files,
    coverage: state.sourceConfigCoverage,
    targets,
    metrics,
  });
}
