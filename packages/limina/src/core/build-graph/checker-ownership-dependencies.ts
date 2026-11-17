import type { ResolvedLiminaInputs } from '#config/runner';
import type { AutoScopeProject } from './auto-checker-types';
import type { CheckerOwnershipDiscovery } from './checker-ownership-discovery';
import { addEvidenceIfMissing } from './checker-ownership-evidence';
import {
  assertLockedDependencyFacts,
  declarationDependencyTarget,
} from './checker-ownership-fact-qualification';
import {
  collectRequirementsForConsumer,
  createActualMembershipIndex,
} from './checker-ownership-membership';
import type {
  CheckerDependencyFact,
  TypeConfigOwnershipState,
} from './checker-ownership-types';
import type { FileOwnerLookup } from './file-owner-lookup';
export { collectCheckerDependencyFacts } from './checker-ownership-dependency-facts';

interface DependencyRequirementPass {
  changed: boolean;
  problems: string[];
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
  config: ResolvedLiminaInputs;
  facts: readonly CheckerDependencyFact[];
  membership: FileOwnerLookup;
  projects: ReadonlyMap<string, AutoScopeProject>;
  state: TypeConfigOwnershipState;
}): DependencyRequirementPass {
  if (options.state.authoritativeOwner !== undefined) {
    return { changed: false, problems: [] };
  }
  const requirements = collectRequirementsForConsumer(options);
  const before = JSON.stringify(options.state.evidence);
  options.state.evidence = options.state.evidence.filter(
    (entry) => entry.source !== 'dependency',
  );
  for (const evidence of requirements.evidence.values())
    addEvidenceIfMissing(options.state, evidence);
  return {
    changed: JSON.stringify(options.state.evidence) !== before,
    problems: requirements.problems,
  };
}

function getConsumerFacts(
  factsByConsumer: ReadonlyMap<string, CheckerDependencyFact[]>,
  configPath: string,
): CheckerDependencyFact[] {
  return factsByConsumer.get(configPath) ?? [];
}

export function applyDependencyRequirementPass(options: {
  config: ResolvedLiminaInputs;
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
      projects: options.discovery.projectByConfigPath,
      state,
    });
    if (applied.changed) result.changed = true;
    result.problems.push(...applied.problems);
  }
  return result;
}

function addOwnershipDependency(options: {
  dependencies: Map<string, Set<string>>;
  fact: CheckerDependencyFact;
  membership: FileOwnerLookup;
}): void {
  const target = declarationDependencyTarget(options.fact, options.membership);
  if (target === null || target === options.fact.consumerConfigPath) return;
  options.dependencies.get(options.fact.consumerConfigPath)?.add(target);
}

export function createOwnershipDependenciesByConfig(options: {
  discovery: CheckerOwnershipDiscovery;
}): Map<string, Set<string>> {
  assertLockedDependencyFacts(options.discovery.plan);
  const membership = createActualMembershipIndex(
    options.discovery.projectByConfigPath,
  );
  const dependencies = new Map(
    options.discovery.plan.typeConfigs
      .keys()
      .map((configPath) => [configPath, new Set<string>()]),
  );
  for (const fact of options.discovery.plan.dependencyFacts) {
    addOwnershipDependency({ dependencies, fact, membership });
  }
  return dependencies;
}
