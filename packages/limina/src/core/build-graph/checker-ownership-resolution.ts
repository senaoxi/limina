import type { CheckerProjectConfigCache } from '#checkers';
import type { ResolvedLiminaInputs } from '#config/runner';
import type { ImportAnalysisContext } from '#core/import-analysis/runner';
import { toRelativePath } from '#utils/path';
import { currentProfile } from '../../application/analysis/observability';
import { LiminaStructuredError } from '../../check-reporting/errors';
import { observeAsyncWork, observeWork } from '../analysis-profile';
import type { ProjectDependencyCaches } from '../project-dependencies/contracts';
import { createProjectDependencyCaches } from '../project-dependencies/runner';
import type { WorkspaceRegionPathIndex } from '../workspace/validated-context';
import { assertCollectedExecution } from './analysis-failure';
import { promoteDirectedCheckerDependencies } from './auto-checker-promotion';
import { colorBuildCheckerComponents } from './checker-build-coloring';
import {
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
  assertOwnershipPhase,
} from './checker-ownership-evidence';
import {
  finalizeOwnership,
  validateOwnershipConstraints,
} from './checker-ownership-finalization';
import type { TypeConfigOwnershipState } from './checker-ownership-types';
import { validateFrozenSemanticAuthorities } from './checker-semantic-authority';
import {
  coreCollectionRun,
  recordFrameworkInferenceAmbiguities,
} from './core-collection-run';
import { createGeneratedGraphStructuredError } from './problems';
import type {
  CheckerSelectionResolution,
  CoreAnalysisPhase,
  CoreAnalysisPhaseObserver,
} from './types';

function hasVueRequirement(state: TypeConfigOwnershipState): boolean {
  return (
    state.localOwner.kind === 'resolved' &&
    state.localOwner.checker === 'vue-tsc'
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

interface CheckerOwnershipOptions {
  activatedRegions: WorkspaceRegionPathIndex;
  config: ResolvedLiminaInputs;
  importAnalysisContext: ImportAnalysisContext;
  onPhase?: CoreAnalysisPhaseObserver;
  projectDependencyCaches?: ProjectDependencyCaches;
  projectConfigCache?: CheckerProjectConfigCache;
  workspaceSourceConfigPaths: readonly string[];
}

async function withAsyncPhase<T>(
  onPhase: CoreAnalysisPhaseObserver | undefined,
  phase: CoreAnalysisPhase,
  run: () => Promise<T>,
): Promise<T> {
  const handle = onPhase?.(phase);
  try {
    const result = await run();
    handle?.pass();
    return result;
  } catch (error) {
    handle?.fail();
    throw error;
  }
}

function withSyncPhase<T>(
  onPhase: CoreAnalysisPhaseObserver | undefined,
  phase: CoreAnalysisPhase,
  run: () => T,
): T {
  const handle = onPhase?.(phase);
  try {
    const result = run();
    handle?.pass();
    return result;
  } catch (error) {
    handle?.fail();
    throw error;
  }
}

export async function prepareCheckerOwnership(
  options: CheckerOwnershipOptions,
): Promise<() => CheckerSelectionResolution> {
  const observer = currentProfile();
  const scoped = {
    ...options,
    projectDependencyCaches:
      options.projectDependencyCaches ?? createProjectDependencyCaches(),
  };
  const discovery = await withAsyncPhase(
    options.onPhase,
    'ownership-discovery',
    () =>
      observeAsyncWork(observer, 'checker-ownership-discovery', () =>
        discoverCheckerOwnership(scoped),
      ),
  );
  return () => resolveCheckerOwnership(scoped, discovery);
}

function resolveCheckerOwnership(
  options: CheckerOwnershipOptions,
  discovery: CheckerOwnershipDiscovery,
): CheckerSelectionResolution {
  const observer = currentProfile();
  discovery.collectionProblems ??= [];
  deferOwnershipProblems(discovery, () =>
    validateOwnershipConstraints({
      config: options.config,
      discovery,
      phase: 'config evidence',
    }),
  );
  if (options.projectDependencyCaches !== undefined)
    recordFrameworkInferenceAmbiguities(
      options.projectDependencyCaches,
      discovery.ambiguities ?? [],
    );
  withSyncPhase(options.onPhase, 'dependency-analysis', () =>
    collectFrozenDependencyFacts(options, discovery),
  );
  if (options.projectDependencyCaches)
    coreCollectionRun(options.projectDependencyCaches).closed = true;
  assertOwnershipPhase({
    config: options.config,
    fallback: 'Failed to resolve checker governance.',
    problems: discovery.collectionProblems,
  });
  assertCollectedExecution(options.projectDependencyCaches);
  if (discovery.collectionInputFailure !== undefined)
    throw discovery.collectionInputFailure;
  withSyncPhase(options.onPhase, 'ownership-finalization', () =>
    observeWork(observer, 'checker-ownership-finalization', () =>
      finalizeLockedOwnership({ config: options.config, discovery }),
    ),
  );
  return {
    frozenProjectsByConfigPath: discovery.frozenProjectsByConfigPath,
    ownershipPlan: discovery.plan,
    selections: createOwnershipSelections({
      config: options.config,
      discovery,
    }),
  };
}

export function finalizeLockedOwnership(options: {
  config: ResolvedLiminaInputs;
  discovery: CheckerOwnershipDiscovery;
}): void {
  const { discovery } = options;
  discovery.plan.coloringInputs = {
    version: 1,
    seeds: structuredClone(discovery.plan.typeConfigs),
  };
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
}

function collectFrozenDependencyFacts(
  options: CheckerOwnershipOptions,
  discovery: CheckerOwnershipDiscovery,
): void {
  const collect = () =>
    collectCheckerDependencyFacts({
      config: options.config,
      discovery,
      importAnalysis: options.importAnalysisContext,
      projectDependencyCaches: options.projectDependencyCaches,
    });
  const observer = currentProfile();
  if (observer === undefined) {
    discovery.collectionProblems!.push(...collect());
    return;
  }
  const work = observer.start('locked-dependency-analysis');
  try {
    const problems = observer.inWork(work, collect);
    observer.finish(work);
    discovery.collectionProblems!.push(...problems);
  } catch (error) {
    observer.fail(work, error);
    throw error;
  }
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
