import type { CheckerName, ResolvedLiminaConfig } from '#config/runner';
import { compareCodeUnits } from '#utils/collections';
import { normalizeAbsolutePath, toRelativePath } from '#utils/path';
import type { AutoScopeProject } from './auto-checker-types';
import type {
  CheckerDependencyFact,
  CheckerEvidence,
  CheckerOwnershipPlan,
  TypeConfigOwnershipState,
} from './checker-ownership-types';

const frameworkCheckers = new Set<CheckerName>([
  'astro',
  'svelte-check',
  'vue-tsc',
]);

interface RequirementResolution {
  evidence?: { checker: CheckerName; value: CheckerEvidence };
  problem?: string;
}

function addActualMembership(
  owners: Map<string, Set<string>>,
  fileName: string,
  configPath: string,
): void {
  const normalized = normalizeAbsolutePath(fileName);
  const values = owners.get(normalized);
  if (values === undefined) {
    owners.set(normalized, new Set([configPath]));
    return;
  }
  values.add(configPath);
}

export function createActualMembershipIndex(
  projects: ReadonlyMap<string, AutoScopeProject>,
): Map<string, string[]> {
  const owners = new Map<string, Set<string>>();
  for (const project of projects.values()) {
    for (const fileName of project.fileNames) {
      addActualMembership(owners, fileName, project.configPath);
    }
  }
  return new Map(
    [...owners].map(([fileName, configPaths]) => [
      fileName,
      [...configPaths].sort(compareCodeUnits),
    ]),
  );
}

function frameworkCheckerOrNull(checker: CheckerName): CheckerName | null {
  return frameworkCheckers.has(checker) ? checker : null;
}

function getPendingFrameworkConstraint(
  state: TypeConfigOwnershipState,
): CheckerName | null {
  if (state.constraintCandidates.size !== 1) return null;
  return frameworkCheckerOrNull(
    state.constraintCandidates.keys().next().value as CheckerName,
  );
}

function getFrameworkDomain(
  plan: CheckerOwnershipPlan,
  configPath: string,
): CheckerName | null {
  const state = plan.typeConfigs.get(configPath);
  if (state === undefined) return null;
  return state.localOwner.kind === 'resolved'
    ? frameworkCheckerOrNull(state.localOwner.checker)
    : getPendingFrameworkConstraint(state);
}

function formatAmbiguousMembership(options: {
  config: ResolvedLiminaConfig;
  fact: CheckerDependencyFact;
  owners: readonly string[];
}): string {
  return [
    'Ambiguous governed source ownership:',
    `  importing config: ${toRelativePath(options.config.rootDir, options.fact.consumerConfigPath)}`,
    `  file: ${toRelativePath(options.config.rootDir, options.fact.importRecord.filePath)}:${options.fact.importRecord.line}`,
    `  imported specifier: ${options.fact.importRecord.specifier}`,
    `  physical target: ${toRelativePath(options.config.rootDir, options.fact.physicalTargetPath!)}`,
    '  actual owning configs:',
    ...options.owners.map(
      (owner) => `    - ${toRelativePath(options.config.rootDir, owner)}`,
    ),
    '  reason: dependency coloring requires exactly one actual effective-file membership.',
  ].join('\n');
}

function createRequirementEvidence(options: {
  checker: CheckerName;
  config: ResolvedLiminaConfig;
  fact: CheckerDependencyFact;
  targetConfigPath: string;
}): CheckerEvidence {
  return {
    checker: options.checker,
    configPath: options.fact.consumerConfigPath,
    detail: [
      `${toRelativePath(options.config.rootDir, options.fact.importRecord.filePath)}:${options.fact.importRecord.line}`,
      `imports ${options.fact.importRecord.specifier}`,
      `resolved to ${toRelativePath(options.config.rootDir, options.fact.physicalTargetPath!)}`,
      `governed by ${toRelativePath(options.config.rootDir, options.targetConfigPath)}`,
    ].join(' '),
    source: 'dependency',
  };
}

function getMissingPhysicalTarget(fact: CheckerDependencyFact): string | null {
  if (fact.typeEvidenceKind !== 'missing') return null;
  return fact.physicalTargetPath;
}

function resolveFrameworkDomain(options: {
  config: ResolvedLiminaConfig;
  fact: CheckerDependencyFact;
  plan: CheckerOwnershipPlan;
  targetConfigPath: string;
}): RequirementResolution {
  const checker = getFrameworkDomain(options.plan, options.targetConfigPath);
  if (checker === null) return {};
  return {
    evidence: {
      checker,
      value: createRequirementEvidence({ ...options, checker }),
    },
  };
}

function resolveOwnedPhysicalTarget(options: {
  config: ResolvedLiminaConfig;
  fact: CheckerDependencyFact;
  membership: ReadonlyMap<string, string[]>;
  plan: CheckerOwnershipPlan;
  targetPath: string;
}): RequirementResolution {
  const owners = getMembershipOwners(options.membership, options.targetPath);
  if (owners.length > 1) {
    return {
      problem: formatAmbiguousMembership({
        config: options.config,
        fact: options.fact,
        owners,
      }),
    };
  }
  const targetConfigPath = owners[0];
  if (targetConfigPath === undefined) return {};
  return resolveFrameworkDomain({ ...options, targetConfigPath });
}

function getMembershipOwners(
  membership: ReadonlyMap<string, string[]>,
  targetPath: string,
): string[] {
  return membership.get(targetPath) ?? [];
}

function resolveRequirement(options: {
  config: ResolvedLiminaConfig;
  fact: CheckerDependencyFact;
  membership: ReadonlyMap<string, string[]>;
  plan: CheckerOwnershipPlan;
}): RequirementResolution {
  const targetPath = getMissingPhysicalTarget(options.fact);
  if (targetPath === null) return {};
  return resolveOwnedPhysicalTarget({ ...options, targetPath });
}

function appendRequirementResolution(options: {
  evidence: Map<CheckerName, CheckerEvidence>;
  problems: string[];
  resolution: RequirementResolution;
}): void {
  appendRequirementProblem(options.problems, options.resolution.problem);
  appendRequirementEvidence(options.evidence, options.resolution.evidence);
}

function appendRequirementProblem(
  problems: string[],
  problem: string | undefined,
): void {
  if (problem !== undefined) problems.push(problem);
}

function appendRequirementEvidence(
  evidence: Map<CheckerName, CheckerEvidence>,
  resolved: RequirementResolution['evidence'],
): void {
  if (resolved === undefined) return;
  if (!evidence.has(resolved.checker)) {
    evidence.set(resolved.checker, resolved.value);
  }
}

export function collectRequirementsForConsumer(options: {
  config: ResolvedLiminaConfig;
  facts: readonly CheckerDependencyFact[];
  membership: ReadonlyMap<string, string[]>;
  plan: CheckerOwnershipPlan;
}): { evidence: Map<CheckerName, CheckerEvidence>; problems: string[] } {
  const evidence = new Map<CheckerName, CheckerEvidence>();
  const problems: string[] = [];
  for (const fact of options.facts) {
    appendRequirementResolution({
      evidence,
      problems,
      resolution: resolveRequirement({ ...options, fact }),
    });
  }
  return { evidence, problems };
}
