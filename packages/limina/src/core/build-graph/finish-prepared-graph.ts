import { isSourceKnipEnabled, type ResolvedLiminaInputs } from '#config/runner';
import { completeFrameworkExecutionInputs } from '../analysis-cache/framework-execution-inputs';
import type { ProjectDependencyCaches } from '../project-dependencies/contracts';
import type { ValidatedWorkspaceContext } from '../workspace/validated-context';
import { captureGeneratedGraph } from './analysis-cache';
import { finishAnalysisOutcome } from './analysis-outcome';
import { assertGeneratedGraphAdmission } from './candidate-build-plan';
import { coreCollectionRun } from './core-collection-run';
import { validateStagedDeclarationContexts } from './declaration-context-candidate';
import { finalizeGeneratedGraph } from './finalize-generated-graph';
import { prepareGeneratedKnipPackageConfigs } from './generated-knip';
import { assertGeneratedReferenceBinding } from './generated-reference-binding';
import { observeOutputProjections } from './observe-output-projections';
import type { createGeneratedGraphPreparationState } from './prepare-state';
import { validateStagedReferences } from './reference-validation';
import type {
  DependencyAnalysisResult,
  GeneratedTsconfigGraphResult,
  PrepareGeneratedTsconfigGraphOptions,
} from './types';
import { writeGeneratedGraphConfigs } from './write-generated-graph';

export async function finishPreparedGraph(input: {
  isAnalysisOnly: boolean;
  checkers: Parameters<typeof prepareGeneratedKnip>[0]['checkers'];
  config: ResolvedLiminaInputs;
  state: ReturnType<typeof createGeneratedGraphPreparationState>;
  workspaceContext: ValidatedWorkspaceContext;
  options: PrepareGeneratedTsconfigGraphOptions;
  projectDependencyCaches: ProjectDependencyCaches;
}): Promise<GeneratedTsconfigGraphResult | DependencyAnalysisResult> {
  const {
    config,
    checkers,
    state,
    options,
    workspaceContext,
    projectDependencyCaches,
  } = input;
  if (input.isAnalysisOnly) return state.dependencyAnalysis;
  state.sourceConfigCoverage = projectDependencyCaches.sourceConfigCoverage;
  const generatedKnip = prepareGeneratedKnip({
    checkers,
    config,
    state,
    workspaceContext,
  });
  await writeGeneratedGraphConfigs({
    cache: projectDependencyCaches.analysisCache,
    checkers,
    config,
    generatedKnip,
    state,
  });
  validateStagedReferences(state);
  observeOutputProjections(state, projectDependencyCaches);
  validateStagedDeclarationContexts(state, projectDependencyCaches.metrics);
  const run = coreCollectionRun(projectDependencyCaches);
  if (run.transaction !== 'failed') run.transaction = 'completed';
  finishAnalysisOutcome(
    state.dependencyAnalysis,
    projectDependencyCaches,
    state.dependencyAnalysis.outcome!.governance,
  );
  assertGeneratedGraphAdmission({ config, state });
  const result = await finalizeGeneratedGraph({
    artifactNamespace: options.artifactNamespace,
    checkers,
    config,
    generatedKnip,
    state,
  });
  assertReferenceBinding(result, config);
  await completeFrameworkExecutionInputs(result, config);
  result.dependencyAnalysis = state.dependencyAnalysis;
  result.sourceConfigCoverage = projectDependencyCaches.sourceConfigCoverage;
  capturePreparedGraph({
    config,
    options,
    workspaceContext,
    result,
    analysis: state.dependencyAnalysis,
  });
  return result;
}
function prepareGeneratedKnip(options: {
  checkers: Parameters<
    typeof prepareGeneratedKnipPackageConfigs
  >[0]['checkers'];
  config: ResolvedLiminaInputs;
  state: ReturnType<typeof createGeneratedGraphPreparationState>;
  workspaceContext: ValidatedWorkspaceContext;
}): ReturnType<typeof prepareGeneratedKnipPackageConfigs> {
  if (!isSourceKnipEnabled(options.config)) {
    return { configs: [], diagnostics: [] };
  }
  return prepareGeneratedKnipPackageConfigs({
    checkers: options.checkers,
    config: options.config,
    configToOutputBuildByChecker: options.state.configToOutputBuildByChecker,
    workspacePackages: options.workspaceContext.packages,
    workspaceContext: options.workspaceContext,
  });
}

function capturePreparedGraph(input: {
  config: ResolvedLiminaInputs;
  options: PrepareGeneratedTsconfigGraphOptions;
  workspaceContext: ValidatedWorkspaceContext;
  result: GeneratedTsconfigGraphResult;
  analysis: DependencyAnalysisResult;
}): void {
  const cache = input.options.projectDependencyCaches?.analysisCache;
  if (cache !== undefined)
    captureGeneratedGraph({
      cache,
      config: input.config,
      workspace: input.workspaceContext,
      result: input.result,
      analysis: input.analysis,
    });
}

function assertReferenceBinding(
  graph: GeneratedTsconfigGraphResult,
  config: ResolvedLiminaInputs,
): void {
  assertGeneratedReferenceBinding(graph, config);
}
