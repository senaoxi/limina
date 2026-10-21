import type { ResolvedLiminaInputs } from '#config/runner';
import type { CandidateBuildPlan } from './analysis-admission';
import { CandidateAdmissionUnavailable } from './analysis-admission';
import type { GeneratedGraphPreparationState } from './prepare-state';
import { createGeneratedGraphStructuredError } from './problems';
export function createCandidateBuildPlan(
  sources: readonly { configPath: string }[],
  edges: GeneratedGraphPreparationState['dependencyEdges'],
): CandidateBuildPlan {
  return {
    configPaths: [...new Set(sources.map((source) => source.configPath))],
    schedules: edges
      .filter((edge) => edge.kind === 'framework-schedule')
      .map((edge) => ({ from: edge.fromConfigPath, to: edge.toConfigPath })),
    references: edges
      .filter((edge) => edge.kind === 'declaration-provider')
      .map((edge) => ({ from: edge.fromConfigPath, to: edge.toConfigPath })),
  };
}

export function assertGeneratedGraphAdmission(options: {
  config: ResolvedLiminaInputs;
  state: GeneratedGraphPreparationState;
}): void {
  const admission = options.state.dependencyAnalysis.outcome!.buildAdmission;
  if (admission.state === 'unavailable')
    throw new CandidateAdmissionUnavailable(admission.reasons);
  if (admission.state !== 'admitted') {
    throw createGeneratedGraphStructuredError({
      config: options.config,
      fallback: 'Failed to prepare generated tsconfig graph.',
      problems: [...admission.reasons],
    });
  }
}
