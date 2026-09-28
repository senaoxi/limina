import type { CheckerName, ResolvedLiminaConfig } from '#config/runner';
import { toRelativePath } from '#utils/path';
import type { AutoScopeProject } from './auto-checker-types';
import type {
  CheckerEvidence,
  CheckerOwnershipPlan,
  SolutionOwnershipState,
  TypeConfigOwnershipState,
} from './checker-ownership-types';
import { lockSemanticAuthorityForEvidence } from './checker-semantic-authority';
import { createGeneratedGraphStructuredError } from './problems';

function formatLocalConflict(options: {
  config: ResolvedLiminaConfig;
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

function addEvidenceIfMissing(
  state: TypeConfigOwnershipState,
  evidence: CheckerEvidence,
): void {
  const exists = state.evidence.some(
    (entry) =>
      entry.checker === evidence.checker &&
      entry.detail === evidence.detail &&
      entry.source === evidence.source,
  );
  if (!exists) state.evidence.push({ ...evidence });
}

function addAuthoritativeCheckerRequirement(options: {
  checker: CheckerName;
  config: ResolvedLiminaConfig;
  detail: string;
  evidenceConfigPath: string;
  state: TypeConfigOwnershipState;
}): string | null {
  const current = options.state.authoritativeOwner;
  if (current !== undefined && current !== options.checker) {
    return [
      'Checker ownership conflict:',
      `  config: ${toRelativePath(options.config.rootDir, options.state.configPath)}`,
      `  authoritative checker: ${current}`,
      `  incompatible authoritative checker: ${options.checker}`,
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
  config: ResolvedLiminaConfig;
  evidence: CheckerEvidence;
  state: TypeConfigOwnershipState;
}): string | null {
  addEvidenceIfMissing(options.state, options.evidence);
  const semanticProblem = lockSemanticAuthorityForEvidence(options);
  if (semanticProblem !== null) return semanticProblem;
  return resolveLocalCheckerRequirement(options);
}

function resolveLocalCheckerRequirement(options: {
  config: ResolvedLiminaConfig;
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
  if (current.checker === options.evidence.checker) return null;
  return formatLocalConflict({ ...options, current: current.checker });
}

export function addSolutionRequirement(options: {
  checker: CheckerName;
  config: ResolvedLiminaConfig;
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
  config: ResolvedLiminaConfig;
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
      ...solution.leafConfigPaths.flatMap((leafConfigPath) => {
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
  config: ResolvedLiminaConfig;
  explicitOwnerByEntryPath: ReadonlyMap<string, CheckerName>;
  plan: CheckerOwnershipPlan;
}): string[] {
  return [...options.explicitOwnerByEntryPath].flatMap(([entryPath, checker]) =>
    applyExplicitRequirement({ ...options, checker, entryPath }),
  );
}

function collectRootRequirements(
  project: AutoScopeProject,
): { checker: CheckerName; fileName: string }[] {
  const candidates = [
    ...project.filePartition.astroFiles.map((fileName) => ({
      checker: 'astro' as const,
      fileName,
    })),
    ...project.filePartition.svelteFiles.map((fileName) => ({
      checker: 'svelte-check' as const,
      fileName,
    })),
    ...project.filePartition.vueFiles.map((fileName) => ({
      checker: 'vue-tsc' as const,
      fileName,
    })),
  ];
  const firstByChecker = new Map<CheckerName, string>();
  for (const candidate of candidates) {
    if (!firstByChecker.has(candidate.checker)) {
      firstByChecker.set(candidate.checker, candidate.fileName);
    }
  }
  return [...firstByChecker].map(([checker, fileName]) => ({
    checker,
    fileName,
  }));
}

function applyRootRequirement(options: {
  config: ResolvedLiminaConfig;
  project: AutoScopeProject;
  requirement: { checker: CheckerName; fileName: string };
  state: TypeConfigOwnershipState;
}): string[] {
  const problem = addLocalCheckerRequirement({
    config: options.config,
    evidence: {
      checker: options.requirement.checker,
      configPath: options.project.configPath,
      detail: `effective root file ${toRelativePath(options.config.rootDir, options.requirement.fileName)}`,
      source: 'root-file',
    },
    state: options.state,
  });
  return problemArray(problem);
}

export function applyRootFileEvidence(options: {
  config: ResolvedLiminaConfig;
  plan: CheckerOwnershipPlan;
  projectByConfigPath: ReadonlyMap<string, AutoScopeProject>;
}): string[] {
  return [...options.projectByConfigPath.values()].flatMap((project) => {
    const state = options.plan.typeConfigs.get(project.configPath)!;
    if (state.authoritativeOwner !== undefined) return [];
    return collectRootRequirements(project).flatMap((requirement) =>
      applyRootRequirement({ ...options, project, requirement, state }),
    );
  });
}

export function assertOwnershipPhase(options: {
  config: ResolvedLiminaConfig;
  fallback: string;
  problems: string[];
}): void {
  if (options.problems.length === 0) return;
  throw createGeneratedGraphStructuredError(options);
}
