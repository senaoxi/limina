import type { ProjectDependencyCaches } from '../project-dependencies/contracts';
import { observationErrorDetail } from '../typescript-semantic/native-observation-failure';
import { retainAnalysisFailure } from './analysis-failure';
import { proveOutputProjection } from './output-projection';
import type { GeneratedGraphPreparationState } from './prepare-state';
import type { SourceProject } from './types';

export function observeOutputProjections(
  state: GeneratedGraphPreparationState,
  caches: ProjectDependencyCaches,
): void {
  for (const projects of state.outputProjectsByChecker.values()) {
    for (const project of projects) observeOutput({ state, caches, project });
  }
}

function observeOutput(input: {
  state: GeneratedGraphPreparationState;
  caches: ProjectDependencyCaches;
  project: SourceProject;
}): void {
  try {
    const receipt = proveOutputProjection({
      ...input,
      cache: input.caches.analysisCache,
      metrics: input.caches.metrics,
    });
    (input.project.outputProjections ??= []).push(receipt);
  } catch (error) {
    input.state.dependencyAnalysis.diagnostics.push(
      observationErrorDetail(error),
    );
    retainAnalysisFailure(input.caches, error, input.project.configPath);
  }
}
