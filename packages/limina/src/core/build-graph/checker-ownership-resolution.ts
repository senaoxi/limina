import type { ResolvedLiminaInputs } from '#config/runner';
import { toRelativePath } from '#utils/path';
import { LiminaStructuredError } from '../../check-reporting/errors';
import type { ProjectDependencyCaches } from '../project-dependencies/contracts';
import type { WorkspaceRegionPathIndex } from '../workspace/validated-context';
import { assertCollectedExecution } from './analysis-failure';
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
import { coreCollectionRun } from './core-collection-run';
import { createGeneratedGraphStructuredError } from './problems';
import type {
  CheckerSelectionResolution,
  PrepareGeneratedTsconfigGraphOptions,
} from './types';

function hasVueRequirement(state: TypeConfigOwnershipState): boolean {
  return (
    (state.localOwner.kind === 'resolved' &&
      state.localOwner.checker === 'vue-tsc') ||
    getUniqueConstraint(state) === 'vue-tsc'
  );
}

function getPendingConsumer(
  discovery: CheckerOwnershipDiscovery,
  consumerPath: string,
): TypeConfigOwnershipState | null {
  const consumer = discovery.plan.typeConfigs.get(consumerPath);
  return consumer === undefined || consumer.localOwner.kind === 'resolved'
    ? null
    : consumer;
}

function applyVuePromotion(options: {
  config: ResolvedLiminaInputs;
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

function isPromoteVueConsumer(options: {
  config: ResolvedLiminaInputs;
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
  config: ResolvedLiminaInputs;
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
      isPromoteVueConsumer({ ...options, consumerPath, providerPath }),
  });
}

function runDependencyRequirements(options: {
  config: ResolvedLiminaInputs;
  discovery: CheckerOwnershipDiscovery;
}): void {
  let isChanged = true;
  while (isChanged) {
    const pass = applyDependencyRequirementPass(options);
    options.discovery.collectionProblems!.push(...pass.problems);
    isChanged = pass.changed;
    deferOwnershipProblems(options.discovery, () =>
      validateOwnershipConstraints({
        config: options.config,
        discovery: options.discovery,
        phase: 'dependency requirement analysis',
      }),
    );
  }
}

export async function resolveCheckerOwnership(options: {
  activatedRegions: WorkspaceRegionPathIndex;
  config: ResolvedLiminaInputs;
  importAnalysisContext: NonNullable<
    PrepareGeneratedTsconfigGraphOptions['importAnalysisContext']
  >;
  projectDependencyCaches?: ProjectDependencyCaches;
  projectConfigCache?: PrepareGeneratedTsconfigGraphOptions['projectConfigCache'];
  workspaceSourceConfigPaths: readonly string[];
}): Promise<CheckerSelectionResolution> {
  const discovery = await discoverCheckerOwnership(options);
  discovery.collectionProblems ??= [];
  deferOwnershipProblems(discovery, () =>
    validateOwnershipConstraints({
      config: options.config,
      discovery,
      phase: 'config evidence',
    }),
  );
  discovery.collectionProblems.push(
    ...applyRootFileEvidence({
      config: options.config,
      plan: discovery.plan,
      projectByConfigPath: discovery.projectByConfigPath,
    }),
  );
  deferOwnershipProblems(discovery, () =>
    validateOwnershipConstraints({
      config: options.config,
      discovery,
      phase: 'effective root evidence',
    }),
  );
  discovery.collectionProblems.push(
    ...(await collectCheckerDependencyFacts({
      config: options.config,
      discovery,
      importAnalysis: options.importAnalysisContext,
      projectDependencyCaches: options.projectDependencyCaches,
      projectConfigCache: options.projectConfigCache,
    })),
  );
  runDependencyRequirements({ config: options.config, discovery });
  discovery.collectionProblems.push(
    ...freezeSemanticAuthorities({
      config: options.config,
      states: discovery.plan.typeConfigs
        .values()
        .filter((state) => state.semanticAuthorityUnavailable === undefined),
    }),
  );
  await collectFrozenDependencyFacts(options, discovery);
  if (options.projectDependencyCaches)
    coreCollectionRun(options.projectDependencyCaches).closed = true;
  assertOwnershipPhase({
    config: options.config,
    fallback: 'Failed to resolve checker governance.',
    problems: discovery.collectionProblems,
  });
  assertCollectedExecution(options.projectDependencyCaches);
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

async function collectFrozenDependencyFacts(
  options: Parameters<typeof resolveCheckerOwnership>[0],
  discovery: CheckerOwnershipDiscovery,
): Promise<void> {
  // The phase changes the producer/context identity. Selection observations
  // remain historical evidence; no pending object becomes a locked fact.
  const problems = await collectCheckerDependencyFacts({
    phase: 'locked',
    config: options.config,
    discovery,
    importAnalysis: options.importAnalysisContext,
    projectDependencyCaches: options.projectDependencyCaches,
    projectConfigCache: options.projectConfigCache,
  });
  discovery.collectionProblems!.push(...problems);
}

function deferOwnershipProblems(
  discovery: CheckerOwnershipDiscovery,
  collect: () => void,
): void {
  try {
    collect();
  } catch (error) {
    if (!(error instanceof LiminaStructuredError)) throw error;
    discovery.collectionProblems!.push(error.message);
  }
}
