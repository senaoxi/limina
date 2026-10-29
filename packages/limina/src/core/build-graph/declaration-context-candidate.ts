import type { AnalysisMetricsRecorder } from '../../application/analysis/analysis-run';
import {
  type DeclarationValidationTarget,
  validateDeclarationContexts,
} from './declaration-context-validation';
import type { GeneratedGraphPreparationState } from './prepare-state';
import type { GeneratedTsconfigGraphResult } from './types';

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
        executionRoot: project.context.vueSemanticIdentity?.projectRootDir,
        executionIdentity: project.context.vueSemanticIdentity,
        preset: project.context.checkerPresets[0],
      });
  for (const projects of state.outputProjectsByChecker.values())
    for (const project of projects)
      targets.push({
        sourceConfig: project.configPath,
        generatedConfig: project.outputConfigPath,
        checker: project.checkerName,
        executionRoot: project.context.vueSemanticIdentity?.projectRootDir,
        executionIdentity: project.context.vueSemanticIdentity,
        preset: project.context.checkerPresets[0],
      });
  validateDeclarationContexts({
    analysis: state.dependencyAnalysis,
    files: state.writeContext.files,
    coverage: state.sourceConfigCoverage,
    targets,
    metrics,
    phase: 'generation',
  });
}

/**
Restored facts do not authorize execution of a previous candidate mapping.
*/
export function hasValidRestoredDeclarationContexts(
  graph: Pick<
    GeneratedTsconfigGraphResult,
    | 'dependencyAnalysis'
    | 'sourceToDts'
    | 'configToOutputBuild'
    | 'generatedFiles'
    | 'sourceConfigCoverage'
    | 'governedSources'
  >,
  metrics?: AnalysisMetricsRecorder,
): boolean {
  const analysis = graph.dependencyAnalysis;
  if (analysis === undefined) return false;
  const targets: DeclarationValidationTarget[] = [];
  for (const [checker, sources] of graph.sourceToDts)
    for (const [sourceConfig, generatedConfig] of sources)
      targets.push({
        checker,
        sourceConfig,
        generatedConfig,
        ...restoredAuthority(graph, checker, sourceConfig),
      });
  for (const [checker, sources] of graph.configToOutputBuild)
    for (const [sourceConfig, module] of sources)
      if (module.kind === 'project')
        targets.push({
          checker,
          sourceConfig,
          generatedConfig: module.path,
          ...restoredAuthority(graph, checker, sourceConfig),
        });
  validateDeclarationContexts({
    analysis,
    files: graph.generatedFiles,
    coverage: graph.sourceConfigCoverage,
    targets,
    metrics,
    phase: 'restore',
  });
  return (
    analysis.declarationValidation === undefined ||
    analysis.declarationValidation.state === 'admitted'
  );
}

function restoredAuthority(
  graph: Pick<GeneratedTsconfigGraphResult, 'governedSources'>,
  checker: string,
  source: string,
) {
  const context = graph.governedSources.get(checker)?.get(source)?.context;
  return {
    executionRoot: context?.vueSemanticIdentity?.projectRootDir,
    executionIdentity: context?.vueSemanticIdentity,
    preset: context?.checkerPresets[0],
  };
}
