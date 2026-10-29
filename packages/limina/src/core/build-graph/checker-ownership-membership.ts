import type { CheckerName, ResolvedLiminaInputs } from '#config/runner';
import { toRelativePath } from '#utils/path';
import { qualifyNativeEvidence } from '../../domain/analysis/native-context';
import type { AutoScopeProject } from './auto-checker-types';
import type {
  CheckerDependencyFact,
  CheckerEvidence,
  CheckerOwnershipPlan,
} from './checker-ownership-types';
import { FileOwnerLookup } from './file-owner-lookup';

const frameworkCheckers = new Set<CheckerName>([
  'astro',
  'svelte-check',
  'vue-tsc',
]);

interface RequirementResolution {
  evidence?: { checker: CheckerName; value: CheckerEvidence };
  problem?: string;
}

export function createActualMembershipIndex(
  projects: ReadonlyMap<string, AutoScopeProject>,
): FileOwnerLookup {
  return new FileOwnerLookup(projects.values());
}

function frameworkCheckerOrNull(checker: CheckerName): CheckerName | null {
  return frameworkCheckers.has(checker) ? checker : null;
}

function getFrameworkDomain(
  plan: CheckerOwnershipPlan,
  configPath: string,
): CheckerName | null {
  const state = plan.typeConfigs.get(configPath);
  if (state === undefined) return null;
  return state.localOwner.kind === 'resolved'
    ? frameworkCheckerOrNull(state.localOwner.checker)
    : null;
}

function createRequirementEvidence(options: {
  checker: CheckerName;
  config: ResolvedLiminaInputs;
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
  return fact.physicalTargetProvenance === 'pending-framework-candidate'
    ? fact.physicalTargetPath
    : null;
}

function resolveFrameworkDomain(options: {
  config: ResolvedLiminaInputs;
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
  config: ResolvedLiminaInputs;
  fact: CheckerDependencyFact;
  membership: FileOwnerLookup;
  plan: CheckerOwnershipPlan;
  targetPath: string;
}): RequirementResolution {
  const candidate = options.fact.frameworkCandidate;
  const baseline = options.fact.nativeEvidence?.origin.context;
  return [candidate, baseline].includes(undefined)
    ? {}
    : qualifiedFrameworkRequirement(options, candidate!, baseline!);
}
function qualifiedFrameworkRequirement(
  options: Parameters<typeof resolveOwnedPhysicalTarget>[0],
  candidate: NonNullable<CheckerDependencyFact['frameworkCandidate']>,
  baseline: NonNullable<
    CheckerDependencyFact['nativeEvidence']
  >['origin']['context'],
): RequirementResolution {
  const eligibility = qualifyNativeEvidence(
    candidate.origin,
    baseline,
    'ownership-selection',
  );
  return eligibility.eligible && candidate.coverage.state === 'unique'
    ? resolveFrameworkDomain({
        ...options,
        targetConfigPath: candidate.owningConfigPath,
      })
    : {};
}

function resolveRequirement(options: {
  config: ResolvedLiminaInputs;
  fact: CheckerDependencyFact;
  membership: FileOwnerLookup;
  plan: CheckerOwnershipPlan;
}): RequirementResolution {
  const targetPath = getMissingPhysicalTarget(options.fact);
  return targetPath === null
    ? {}
    : resolveOwnedPhysicalTarget({ ...options, targetPath });
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
  config: ResolvedLiminaInputs;
  facts: readonly CheckerDependencyFact[];
  membership: FileOwnerLookup;
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
