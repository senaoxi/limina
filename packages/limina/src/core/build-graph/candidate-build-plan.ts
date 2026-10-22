import type { ResolvedLiminaInputs } from '#config/runner';
import type { CandidateBuildPlan } from './analysis-admission';
import { CandidateAdmissionUnavailable } from './analysis-admission';
import { bindCompilationProjection } from './compilation-prerequisite';
import type { GeneratedGraphPreparationState } from './prepare-state';
import { createGeneratedGraphStructuredError } from './problems';
import type { GovernedSourceUnit } from './types';
export function createCandidateBuildPlan(
  sources: readonly GovernedSourceUnit[],
  edges: GeneratedGraphPreparationState['dependencyEdges'],
): CandidateBuildPlan {
  const candidate: CandidateBuildPlan = {
    configPaths: [...new Set(sources.map((source) => source.configPath))],
    schedules: edges
      .filter((edge) => edge.kind === 'framework-schedule')
      .map((edge) => ({ from: edge.fromConfigPath, to: edge.toConfigPath })),
    references: projectedReferences(sources),
  };
  bindCompilationProjection(candidate, sources);
  return candidate;
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

export function projectedReferences(
  sources: readonly Pick<
    GovernedSourceUnit,
    'configPath' | 'buildProjection' | 'declarationReferences'
  >[],
): CandidateBuildPlan['references'] {
  const identities = new Map<string, string>();
  for (const source of sources) {
    if ('dtsConfigPath' in source.buildProjection)
      identities.set(source.buildProjection.dtsConfigPath, source.configPath);
  }
  return sources.flatMap((source) =>
    [...source.declarationReferences].flatMap((reference) => {
      const to = identities.get(reference);
      return to === undefined ? [] : [{ from: source.configPath, to }];
    }),
  );
}
