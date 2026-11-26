import type { ResolvedLiminaInputs } from '#config/runner';
import type { NativeAnalysisCache } from '../analysis-cache/native-cache';
import { applyConfigEvidence } from './checker-ownership-config-evidence';
import {
  applyExplicitRequirements,
  commitFrameworkInference,
} from './checker-ownership-evidence';
import type { CheckerOwnershipPlan } from './checker-ownership-types';
import { freezeSemanticAuthorities } from './checker-semantic-authority';
import type { FrameworkInferenceAmbiguity } from './core-collection-run';
import type { AutoScope, ResolvedCheckerEntrySelection } from './types';

export function resolveSourceConfigAuthorities(input: {
  cache?: NativeAnalysisCache;
  config: ResolvedLiminaInputs;
  namedSelections: readonly ResolvedCheckerEntrySelection[];
  plan: CheckerOwnershipPlan;
  scopes: readonly AutoScope[];
}): { problems: string[]; ambiguities: FrameworkInferenceAmbiguity[] } {
  const { cache, config, plan } = input;
  const problems = input.namedSelections.flatMap(({ checker, selection }) =>
    applyExplicitRequirements({
      config,
      explicitOwnerByEntryPath: new Map(
        selection.effectiveEntryPaths.map((entry) => [entry, checker.name]),
      ),
      plan,
    }),
  );
  problems.push(...applyConfigEvidence({ config, plan, scopes: input.scopes }));
  const inference = commitFrameworkInference({ config, plan });
  problems.push(
    ...inference.problems,
    ...freezeSemanticAuthorities({
      config,
      states: plan.typeConfigs
        .values()
        .filter((state) => state.semanticAuthorityUnavailable === undefined),
    }),
  );
  if (cache !== undefined)
    plan.typeConfigs.forEach(() => cache.increment('ownershipResolutions'));
  return { problems, ambiguities: inference.ambiguities };
}
