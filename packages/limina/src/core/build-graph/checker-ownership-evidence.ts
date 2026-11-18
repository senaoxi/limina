import type { CheckerName, ResolvedLiminaInputs } from '#config/runner';
import { compareCodeUnits } from '#utils/collections';
import { toRelativePath } from '#utils/path';
import type {
  CheckerEvidence,
  CheckerOwnershipPlan,
  SolutionOwnershipState,
  TypeConfigOwnershipState,
} from './checker-ownership-types';
import {
  getCheckerSemanticFamily,
  lockSemanticAuthorityForEvidence,
} from './checker-semantic-authority';
import { createGeneratedGraphStructuredError } from './problems';

function formatLocalConflict(options: {
  config: ResolvedLiminaInputs;
  current: CheckerName;
  evidence: CheckerEvidence;
  state: TypeConfigOwnershipState;
}): string {
  const currentEvidence = options.state.evidence.find(
    (entry) => entry.checker === options.current,
  );
  return [
    'Checker ownership conflict:',
    `  config: ${toRelativePath(options.config.rootDir, options.state.configPath)}`,
    `  local owner: ${options.current}`,
    ...(currentEvidence === undefined
      ? []
      : [
          `  owner evidence: ${currentEvidence.source} (${currentEvidence.detail})`,
        ]),
    `  incompatible requirement: ${options.evidence.checker}`,
    `  requirement evidence: ${options.evidence.source} (${options.evidence.detail})`,
    '  reason: the resolved local owner remains unchanged and cannot satisfy the new requirement.',
  ].join('\n');
}

export function addEvidenceIfMissing(
  state: TypeConfigOwnershipState,
  evidence: CheckerEvidence,
): void {
  const isExists = state.evidence.some(
    (entry) =>
      entry.checker === evidence.checker &&
      entry.configPath === evidence.configPath &&
      entry.detail === evidence.detail &&
      entry.source === evidence.source,
  );
  if (!isExists) state.evidence.push({ ...evidence });
}

const frameworkCheckers = new Set<CheckerName>([
  'astro',
  'svelte-check',
  'vue-tsc',
]);

function frameworkInferenceEvidence(
  state: TypeConfigOwnershipState,
): CheckerEvidence[] {
  return state.evidence
    .filter(
      (evidence) =>
        frameworkCheckers.has(evidence.checker) && evidence.source === 'config',
    )
    .sort((left, right) => {
      return (
        compareCodeUnits(left.checker, right.checker) ||
        compareCodeUnits(left.detail, right.detail)
      );
    });
}

export function commitFrameworkInference(options: {
  config: ResolvedLiminaInputs;
  plan: CheckerOwnershipPlan;
}): {
  problems: string[];
  ambiguities: { sourceConfigPath: string; checkers: CheckerName[] }[];
} {
  const problems: string[] = [];
  const ambiguities: { sourceConfigPath: string; checkers: CheckerName[] }[] =
    [];
  for (const state of options.plan.typeConfigs.values()) {
    if (state.authoritativeOwner !== undefined) continue;
    const evidence = frameworkInferenceEvidence(state);
    const checkers = [...new Set(evidence.map((entry) => entry.checker))].sort(
      compareCodeUnits,
    );
    if (checkers.length > 1)
      ambiguities.push({ sourceConfigPath: state.configPath, checkers });
    else if (checkers.length === 1) {
      const problem = addLocalCheckerRequirement({
        ...options,
        state,
        evidence: evidence[0]!,
      });
      if (problem !== null) problems.push(problem);
    }
  }
  return { problems, ambiguities };
}

function addAuthoritativeCheckerRequirement(options: {
  checker: CheckerName;
  config: ResolvedLiminaInputs;
  detail: string;
  evidenceConfigPath: string;
  state: TypeConfigOwnershipState;
}): string | null {
  const current = options.state.authoritativeOwner;
  if (current !== undefined && current !== options.checker) {
    markConflictingExplicitAuthority(options, current);
    return [
      'Checker ownership conflict:',
      `  config: ${toRelativePath(options.config.rootDir, options.state.configPath)}`,
      `  authoritative checker: ${current}`,
      `  incompatible authoritative checker: ${options.checker}`,
      `  existing evidence: ${options.state.evidence
        .filter((entry) => entry.source === 'explicit')
        .map((entry) => entry.detail)
        .join('; ')}`,
      `  evidence: ${options.detail}`,
      '  reason: overlapping explicit checker domains require one identical owner.',
    ].join('\n');
  }
  options.state.authoritativeOwner = options.checker;
  return addLocalCheckerRequirement({
    config: options.config,
    evidence: {
      checker: options.checker,
      configPath: options.evidenceConfigPath,
      detail: options.detail,
      source: 'explicit',
    },
    state: options.state,
  });
}

export function addLocalCheckerRequirement(options: {
  config: ResolvedLiminaInputs;
  evidence: CheckerEvidence;
  state: TypeConfigOwnershipState;
}): string | null {
  addEvidenceIfMissing(options.state, options.evidence);
  const semanticProblem = lockSemanticAuthorityForEvidence(options);
  if (semanticProblem !== null)
    options.state.semanticAuthorityUnavailable = semanticProblem;
  return semanticProblem === null
    ? resolveLocalCheckerRequirement(options)
    : semanticProblem;
}

function resolveLocalCheckerRequirement(options: {
  config: ResolvedLiminaInputs;
  evidence: CheckerEvidence;
  state: TypeConfigOwnershipState;
}): string | null {
  const current = options.state.localOwner;
  if (current.kind === 'pending') {
    options.state.localOwner = {
      checker: options.evidence.checker,
      kind: 'resolved',
    };
    return null;
  }
  return current.checker === options.evidence.checker
    ? null
    : formatLocalConflict({ ...options, current: current.checker });
}

export function addSolutionRequirement(options: {
  checker: CheckerName;
  config: ResolvedLiminaInputs;
  detail: string;
  solution: SolutionOwnershipState;
}): string | null {
  const current = options.solution.declaredConstraint;
  if (current === undefined || current === options.checker) {
    options.solution.declaredConstraint = options.checker;
    return null;
  }
  return [
    'Checker ownership conflict:',
    `  solution: ${toRelativePath(options.config.rootDir, options.solution.configPath)}`,
    `  declared checker: ${current}`,
    `  incompatible checker: ${options.checker}`,
    `  evidence: ${options.detail}`,
  ].join('\n');
}

export function problemArray(problem: string | null): string[] {
  return problem === null ? [] : [problem];
}

function applyExplicitRequirement(options: {
  checker: CheckerName;
  config: ResolvedLiminaInputs;
  entryPath: string;
  plan: CheckerOwnershipPlan;
}): string[] {
  const solution = options.plan.solutions.get(options.entryPath);
  if (solution !== undefined) {
    const problem = addSolutionRequirement({
      checker: options.checker,
      config: options.config,
      detail: 'explicit named checker include',
      solution,
    });
    return [
      ...problemArray(problem),
      ...solution.sourceConfigPaths.flatMap((leafConfigPath) => {
        const state = options.plan.typeConfigs.get(leafConfigPath);
        if (state === undefined) return [];
        return problemArray(
          addAuthoritativeCheckerRequirement({
            checker: options.checker,
            config: options.config,
            detail: `explicit solution ${toRelativePath(options.config.rootDir, options.entryPath)} owns this terminal leaf`,
            evidenceConfigPath: options.entryPath,
            state,
          }),
        );
      }),
    ];
  }
  const state = options.plan.typeConfigs.get(options.entryPath);
  if (state === undefined) return [];
  const problem = addAuthoritativeCheckerRequirement({
    checker: options.checker,
    config: options.config,
    detail: 'explicit named checker include',
    evidenceConfigPath: options.entryPath,
    state,
  });
  return problemArray(problem);
}

export function applyExplicitRequirements(options: {
  config: ResolvedLiminaInputs;
  explicitOwnerByEntryPath: ReadonlyMap<string, CheckerName>;
  plan: CheckerOwnershipPlan;
}): string[] {
  return [...options.explicitOwnerByEntryPath].flatMap(([entryPath, checker]) =>
    applyExplicitRequirement({ ...options, checker, entryPath }),
  );
}

export function assertOwnershipPhase(options: {
  config: ResolvedLiminaInputs;
  fallback: string;
  problems: string[];
}): void {
  if (options.problems.length === 0) return;
  throw createGeneratedGraphStructuredError(options);
}

function markConflictingExplicitAuthority(
  options: Parameters<typeof addAuthoritativeCheckerRequirement>[0],
  current: CheckerName,
): void {
  if (
    getCheckerSemanticFamily(current) !==
    getCheckerSemanticFamily(options.checker)
  )
    options.state.semanticAuthorityUnavailable =
      'conflicting-explicit-semantic-authority';
}
