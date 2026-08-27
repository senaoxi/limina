import type { CheckerName, ResolvedLiminaConfig } from '#config/runner';
import {
  addLocalCheckerRequirement,
  addSolutionRequirement,
  problemArray,
} from './checker-ownership-evidence';
import type { CheckerOwnershipPlan } from './checker-ownership-types';
import type { AutoScope } from './types';

function familyChecker(family: 'astro' | 'svelte' | 'vue'): CheckerName {
  if (family === 'svelte') return 'svelte-check';
  return family === 'vue' ? 'vue-tsc' : 'astro';
}

function applyTypeConfigHint(options: {
  checker: CheckerName;
  config: ResolvedLiminaConfig;
  configPath: string;
  detail: string;
  plan: CheckerOwnershipPlan;
}): string[] {
  const state = options.plan.typeConfigs.get(options.configPath);
  if (state === undefined) return [];
  if (state.authoritativeOwner !== undefined) return [];
  return problemArray(
    addLocalCheckerRequirement({
      config: options.config,
      evidence: {
        checker: options.checker,
        configPath: options.configPath,
        detail: options.detail,
        source: 'config',
      },
      state,
    }),
  );
}

function applyConfigHint(options: {
  config: ResolvedLiminaConfig;
  configPath: string;
  hint: AutoScope['frameworkEvidence'][number]['intentHints'][number];
  plan: CheckerOwnershipPlan;
}): string[] {
  const checker = familyChecker(options.hint.family);
  const detail = `${options.hint.kind}: ${options.hint.value}`;
  const solution = options.plan.solutions.get(options.configPath);
  if (solution !== undefined) {
    return problemArray(
      addSolutionRequirement({
        checker,
        config: options.config,
        detail,
        solution,
      }),
    );
  }
  return applyTypeConfigHint({ ...options, checker, detail });
}

export function applyConfigEvidence(options: {
  config: ResolvedLiminaConfig;
  plan: CheckerOwnershipPlan;
  scopes: readonly AutoScope[];
}): string[] {
  const seen = new Set<string>();
  return options.scopes.flatMap((scope) =>
    scope.frameworkEvidence.flatMap((frameworkEvidence) =>
      frameworkEvidence.intentHints.flatMap((hint) => {
        const checker = familyChecker(hint.family);
        const identity = `${frameworkEvidence.configPath}\0${checker}\0${hint.kind}\0${hint.value}`;
        if (seen.has(identity)) return [];
        seen.add(identity);
        return applyConfigHint({
          ...options,
          configPath: frameworkEvidence.configPath,
          hint,
        });
      }),
    ),
  );
}
