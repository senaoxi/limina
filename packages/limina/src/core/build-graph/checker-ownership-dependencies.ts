import type { CheckerName, ResolvedLiminaConfig } from '#config/runner';
import { compareCodeUnits } from '#utils/collections';
import { toRelativePath } from '#utils/path';
import type { CheckerOwnershipDiscovery } from './checker-ownership-discovery';
import { addLocalCheckerRequirement } from './checker-ownership-evidence';
import {
  collectRequirementsForConsumer,
  createActualMembershipIndex,
} from './checker-ownership-membership';
import type {
  CheckerDependencyFact,
  CheckerEvidence,
  CheckerOwnershipPlan,
  TypeConfigOwnershipState,
} from './checker-ownership-types';
export { collectCheckerDependencyFacts } from './checker-ownership-dependency-facts';

interface DependencyRequirementPass {
  changed: boolean;
  problems: string[];
}

function formatMultipleDependencyRequirements(options: {
  config: ResolvedLiminaConfig;
  evidence: ReadonlyMap<CheckerName, CheckerEvidence>;
  state: TypeConfigOwnershipState;
}): string {
  return [
    'Checker ownership conflict:',
    `  config: ${toRelativePath(options.config.rootDir, options.state.configPath)}`,
    ...[...options.evidence]
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .flatMap(([checker, evidence]) => [
        `  requirement: ${checker}`,
        `    evidence: ${evidence.detail}`,
      ]),
    '  reason: dependency analysis found multiple framework checker requirements in one tsconfig.',
  ].join('\n');
}

function hasMultiplePendingRequirements(options: {
  evidence: ReadonlyMap<CheckerName, CheckerEvidence>;
  state: TypeConfigOwnershipState;
}): boolean {
  return (
    options.state.localOwner.kind === 'pending' && options.evidence.size > 1
  );
}

function applyRequirementEvidence(options: {
  config: ResolvedLiminaConfig;
  evidence: ReadonlyMap<CheckerName, CheckerEvidence>;
  state: TypeConfigOwnershipState;
}): string[] {
  const problems: string[] = [];
  for (const evidence of options.evidence.values()) {
    const problem = addLocalCheckerRequirement({ ...options, evidence });
    if (problem !== null) problems.push(problem);
  }
  return problems;
}

function didResolvePending(
  wasPending: boolean,
  state: TypeConfigOwnershipState,
): boolean {
  return wasPending && state.localOwner.kind === 'resolved';
}

function applyConsumerRequirements(options: {
  config: ResolvedLiminaConfig;
  evidence: ReadonlyMap<CheckerName, CheckerEvidence>;
  state: TypeConfigOwnershipState;
}): DependencyRequirementPass {
  if (options.evidence.size === 0) return { changed: false, problems: [] };
  if (hasMultiplePendingRequirements(options)) {
    return {
      changed: false,
      problems: [formatMultipleDependencyRequirements(options)],
    };
  }
  const wasPending = options.state.localOwner.kind === 'pending';
  const problems = applyRequirementEvidence(options);
  return {
    changed: didResolvePending(wasPending, options.state),
    problems,
  };
}

function addConsumerFact(
  factsByConsumer: Map<string, CheckerDependencyFact[]>,
  fact: CheckerDependencyFact,
): void {
  const values = factsByConsumer.get(fact.consumerConfigPath);
  if (values === undefined) {
    factsByConsumer.set(fact.consumerConfigPath, [fact]);
    return;
  }
  values.push(fact);
}

function createFactsByConsumer(
  facts: readonly CheckerDependencyFact[],
): Map<string, CheckerDependencyFact[]> {
  const factsByConsumer = new Map<string, CheckerDependencyFact[]>();
  for (const fact of facts) addConsumerFact(factsByConsumer, fact);
  return factsByConsumer;
}

function applyStateRequirements(options: {
  config: ResolvedLiminaConfig;
  facts: readonly CheckerDependencyFact[];
  membership: ReadonlyMap<string, string[]>;
  plan: CheckerOwnershipPlan;
  state: TypeConfigOwnershipState;
}): DependencyRequirementPass {
  if (options.state.authoritativeOwner !== undefined) {
    return { changed: false, problems: [] };
  }
  const requirements = collectRequirementsForConsumer(options);
  const applied = applyConsumerRequirements({
    ...options,
    evidence: requirements.evidence,
  });
  return {
    changed: applied.changed,
    problems: [...requirements.problems, ...applied.problems],
  };
}

function getConsumerFacts(
  factsByConsumer: ReadonlyMap<string, CheckerDependencyFact[]>,
  configPath: string,
): CheckerDependencyFact[] {
  return factsByConsumer.get(configPath) ?? [];
}

export function applyDependencyRequirementPass(options: {
  config: ResolvedLiminaConfig;
  discovery: CheckerOwnershipDiscovery;
}): DependencyRequirementPass {
  const membership = createActualMembershipIndex(
    options.discovery.projectByConfigPath,
  );
  const factsByConsumer = createFactsByConsumer(
    options.discovery.plan.dependencyFacts,
  );
  const result: DependencyRequirementPass = { changed: false, problems: [] };
  for (const state of options.discovery.plan.typeConfigs.values()) {
    const applied = applyStateRequirements({
      config: options.config,
      facts: getConsumerFacts(factsByConsumer, state.configPath),
      membership,
      plan: options.discovery.plan,
      state,
    });
    if (applied.changed) result.changed = true;
    result.problems.push(...applied.problems);
  }
  return result;
}

function getUniqueMembershipTarget(options: {
  fact: CheckerDependencyFact;
  membership: ReadonlyMap<string, string[]>;
}): string | null {
  if (options.fact.physicalTargetPath === null) return null;
  const owners = getMembershipOwners(
    options.membership,
    options.fact.physicalTargetPath,
  );
  if (owners.length !== 1) return null;
  return owners[0]!;
}

function getMembershipOwners(
  membership: ReadonlyMap<string, string[]>,
  targetPath: string,
): string[] {
  return membership.get(targetPath) ?? [];
}

function getUniqueDependencyTarget(options: {
  fact: CheckerDependencyFact;
  membership: ReadonlyMap<string, string[]>;
}): string | null {
  const target = getUniqueMembershipTarget(options);
  if (target === options.fact.consumerConfigPath) return null;
  return target;
}

function addOwnershipDependency(options: {
  dependencies: Map<string, Set<string>>;
  fact: CheckerDependencyFact;
  membership: ReadonlyMap<string, string[]>;
}): void {
  const target = getUniqueDependencyTarget(options);
  if (target === null) return;
  options.dependencies.get(options.fact.consumerConfigPath)?.add(target);
}

export function createOwnershipDependenciesByConfig(options: {
  discovery: CheckerOwnershipDiscovery;
}): Map<string, Set<string>> {
  const membership = createActualMembershipIndex(
    options.discovery.projectByConfigPath,
  );
  const dependencies = new Map(
    [...options.discovery.plan.typeConfigs.keys()].map((configPath) => [
      configPath,
      new Set<string>(),
    ]),
  );
  for (const fact of options.discovery.plan.dependencyFacts) {
    addOwnershipDependency({ dependencies, fact, membership });
  }
  return dependencies;
}
