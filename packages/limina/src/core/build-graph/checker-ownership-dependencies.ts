import type { CheckerOwnershipDiscovery } from './checker-ownership-discovery';
import {
  assertLockedDependencyFacts,
  declarationDependencyTarget,
} from './checker-ownership-fact-qualification';
import { createActualMembershipIndex } from './checker-ownership-membership';
import type { CheckerDependencyFact } from './checker-ownership-types';
import type { FileOwnerLookup } from './file-owner-lookup';
export { collectCheckerDependencyFacts } from './checker-ownership-dependency-facts';

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
