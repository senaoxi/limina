import type { ResolvedLiminaConfig } from '#config/runner';
import { toRelativePath } from '#utils/path';
import type { ProjectDependencyCaches } from '../project-dependencies/contracts';
import type { WorkspaceRegionPathIndex } from '../workspace/validated-context';
import { promoteDirectedCheckerDependencies } from './auto-checker-promotion';
import { colorBuildCheckerComponents } from './checker-build-coloring';
import {
  applyDependencyRequirementPass,
  collectCheckerDependencyFacts,
  createOwnershipDependenciesByConfig,
} from './checker-ownership-dependencies';
import {
  type CheckerOwnershipDiscovery,
  createOwnershipSelections,
  discoverCheckerOwnership,
} from './checker-ownership-discovery';
import {
  addLocalCheckerRequirement,
  applyRootFileEvidence,
  assertOwnershipPhase,
} from './checker-ownership-evidence';
import {
  finalizeOwnership,
  validateOwnershipConstraints,
} from './checker-ownership-finalization';
import type { TypeConfigOwnershipState } from './checker-ownership-types';
import {
  freezeSemanticAuthorities,
  validateFrozenSemanticAuthorities,
} from './checker-semantic-authority';
import { getUniqueConstraint } from './checker-solution-constraints';
import { createGeneratedGraphStructuredError } from './problems';
import type {
  CheckerSelectionResolution,
  PrepareGeneratedTsconfigGraphOptions,
} from './types';

function hasVueRequirement(state: TypeConfigOwnershipState): boolean {
  if (
    state.localOwner.kind === 'resolved' &&
    state.localOwner.checker === 'vue-tsc'
  ) {
    return true;
  }
  return getUniqueConstraint(state) === 'vue-tsc';
}

function getPendingConsumer(
  discovery: CheckerOwnershipDiscovery,
  consumerPath: string,
): TypeConfigOwnershipState | null {
  const consumer = discovery.plan.typeConfigs.get(consumerPath);
  if (consumer === undefined) return null;
  if (consumer.localOwner.kind === 'resolved') return null;
  return consumer;
}

function applyVuePromotion(options: {
  config: ResolvedLiminaConfig;
  consumer: TypeConfigOwnershipState;
  consumerPath: string;
  providerPath: string;
}): void {
  const problem = addLocalCheckerRequirement({
    config: options.config,
    evidence: {
      checker: 'vue-tsc',
      configPath: options.consumerPath,
      detail: `consumer depends on Vue provider ${toRelativePath(options.config.rootDir, options.providerPath)}`,
      source: 'vue-promotion',
    },
    state: options.consumer,
  });
  if (problem === null) return;
  throw createGeneratedGraphStructuredError({
    config: options.config,
    fallback: 'Failed to promote Vue checker ownership.',
    problems: [problem],
  });
}

function promoteVueConsumer(options: {
  config: ResolvedLiminaConfig;
  consumerPath: string;
  discovery: CheckerOwnershipDiscovery;
  providerPath: string;
}): boolean {
  const consumer = getPendingConsumer(options.discovery, options.consumerPath);
  if (consumer === null) return false;
  applyVuePromotion({ ...options, consumer });
  return true;
}

function isVueProvider(
  discovery: CheckerOwnershipDiscovery,
  providerPath: string,
): boolean {
  const provider = discovery.plan.typeConfigs.get(providerPath);
  return provider !== undefined && hasVueRequirement(provider);
}

function runVuePromotion(options: {
  config: ResolvedLiminaConfig;
  discovery: CheckerOwnershipDiscovery;
}): void {
  promoteDirectedCheckerDependencies({
    dependenciesByConsumer: createOwnershipDependenciesByConfig({
      discovery: options.discovery,
    }),
    isEligibleProvider: (providerPath) =>
      isVueProvider(options.discovery, providerPath),
    onPass: () =>
      validateOwnershipConstraints({
        config: options.config,
        discovery: options.discovery,
        phase: 'directed Vue promotion',
      }),
    promoteConsumer: (consumerPath, providerPath) =>
      promoteVueConsumer({ ...options, consumerPath, providerPath }),
  });
}

function runDependencyRequirements(options: {
  config: ResolvedLiminaConfig;
  discovery: CheckerOwnershipDiscovery;
}): void {
  let changed = true;
  while (changed) {
    const pass = applyDependencyRequirementPass(options);
    assertOwnershipPhase({
      config: options.config,
      fallback: 'Failed to resolve checker dependency requirements.',
      problems: pass.problems,
    });
    changed = pass.changed;
    validateOwnershipConstraints({
      config: options.config,
      discovery: options.discovery,
      phase: 'dependency requirement analysis',
    });
  }
}

export async function resolveCheckerOwnership(options: {
  activatedRegions: WorkspaceRegionPathIndex;
  config: ResolvedLiminaConfig;
  importAnalysisContext: NonNullable<
    PrepareGeneratedTsconfigGraphOptions['importAnalysisContext']
  >;
  projectDependencyCaches?: ProjectDependencyCaches;
  projectConfigCache?: PrepareGeneratedTsconfigGraphOptions['projectConfigCache'];
  workspaceSourceConfigPaths: readonly string[];
}): Promise<CheckerSelectionResolution> {
  const discovery = await discoverCheckerOwnership(options);
  validateOwnershipConstraints({
    config: options.config,
    discovery,
    phase: 'config evidence',
  });
  assertOwnershipPhase({
    config: options.config,
    fallback: 'Failed to resolve checker root-file evidence.',
    problems: applyRootFileEvidence({
      config: options.config,
      plan: discovery.plan,
      projectByConfigPath: discovery.projectByConfigPath,
    }),
  });
  validateOwnershipConstraints({
    config: options.config,
    discovery,
    phase: 'effective root evidence',
  });
  assertOwnershipPhase({
    config: options.config,
    fallback: 'Failed to collect checker dependency evidence.',
    problems: await collectCheckerDependencyFacts({
      config: options.config,
      discovery,
      importAnalysis: options.importAnalysisContext,
      projectDependencyCaches: options.projectDependencyCaches,
      projectConfigCache: options.projectConfigCache,
    }),
  });
  runDependencyRequirements({ config: options.config, discovery });
  assertOwnershipPhase({
    config: options.config,
    fallback: 'Failed to freeze checker semantic authorities.',
    problems: freezeSemanticAuthorities({
      config: options.config,
      states: discovery.plan.typeConfigs.values(),
    }),
  });
  runVuePromotion({ config: options.config, discovery });
  assertOwnershipPhase({
    config: options.config,
    fallback: 'Failed to color build checker declaration components.',
    problems: colorBuildCheckerComponents({
      config: options.config,
      discovery,
    }),
  });
  validateOwnershipConstraints({
    config: options.config,
    discovery,
    phase: 'build checker component coloring',
  });
  assertOwnershipPhase({
    config: options.config,
    fallback: 'Checker build coloring changed frozen semantic authority.',
    problems: validateFrozenSemanticAuthorities({
      config: options.config,
      states: discovery.plan.typeConfigs.values(),
    }),
  });
  finalizeOwnership({ config: options.config, discovery });
  assertOwnershipPhase({
    config: options.config,
    fallback: 'Final checker ownership changed frozen semantic authority.',
    problems: validateFrozenSemanticAuthorities({
      config: options.config,
      states: discovery.plan.typeConfigs.values(),
    }),
  });
  return {
    ownershipPlan: discovery.plan,
    selections: createOwnershipSelections({
      config: options.config,
      discovery,
    }),
  };
}
