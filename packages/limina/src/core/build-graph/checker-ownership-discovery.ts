import { getCheckerExtensions } from '#checkers';
import {
  type CheckerName,
  getAutoCheckerConfig,
  type ResolvedCheckerConfig,
  type ResolvedLiminaInputs,
} from '#config/runner';
import { compareCodeUnits } from '#utils/collections';
import { toPosixPath, toRelativePath } from '#utils/path';
import { currentProfile } from '../../application/analysis/observability';
import type { SourceConfigCoverageIndex } from '../../domain/analysis/native-coverage';
import type { NativeAnalysisCache } from '../analysis-cache/native-cache';
import { observeAsyncWork, observeWork } from '../analysis-profile';
import type { ProjectDependencyCaches } from '../project-dependencies/contracts';
import type { WorkspaceRegionPathIndex } from '../workspace/validated-context';
import { retainAnalysisFailure } from './analysis-failure';
import type { AutoScopeProject } from './auto-checker-types';
import { resolveOwnershipEntries } from './checker-ownership-entries';
import {
  collectOwnershipScopes,
  createCandidateByConfigPath,
  createDirectSolutionReferences,
  createOwnershipPlan,
} from './checker-ownership-graph';
import type { CheckerOwnershipPlan } from './checker-ownership-types';
import type { FrameworkInferenceAmbiguity } from './core-collection-run';
import { recordCoreWork } from './core-collection-run';
import type { FrozenSemanticProject } from './locked-semantic-project';
import { collectUnavailableSourceDiagnostics } from './native-source-baseline';
import { resolveSourceConfigAuthorities } from './source-config-authorities';
import { prepareSourceConfigProjects } from './source-config-projects';
import type {
  AutoScope,
  PrepareGeneratedTsconfigGraphOptions,
  ResolvedCheckerEntrySelection,
} from './types';

export interface CheckerOwnershipDiscovery {
  ambiguities?: readonly FrameworkInferenceAmbiguity[];
  collectionInputFailure?: Error;
  collectionProblems?: string[];
  sourceConfigCoverage?: SourceConfigCoverageIndex;
  activatedRegions?: WorkspaceRegionPathIndex;
  activeEntryPaths: string[];
  autoChecker: 'tsc' | 'tsgo';
  explicitOwnerByEntryPath: Map<string, CheckerName>;
  plan: CheckerOwnershipPlan;
  preparationFailures?: ReadonlyMap<string, unknown>;
  projectByConfigPath: Map<string, AutoScopeProject>;
  frozenProjectsByConfigPath: Map<string, FrozenSemanticProject>;
  scopes: AutoScope[];
}

function createResolvedChecker(options: {
  entries: string[];
  name: CheckerName;
  rootDir: string;
}): ResolvedCheckerConfig {
  const include = options.entries.map((entryPath) =>
    toPosixPath(toRelativePath(options.rootDir, entryPath)),
  );
  return {
    exclude: [],
    extensions:
      options.name === 'astro' || options.name === 'svelte-check'
        ? []
        : getCheckerExtensions(
            options.name,
            { include },
            { projectRootDir: options.rootDir },
          ),
    include,
    name: options.name,
  };
}

function claimExplicitOwner(options: {
  checker: CheckerName;
  config: ResolvedLiminaInputs;
  entryPath: string;
  owners: Map<string, CheckerName>;
}): string[] {
  const current = options.owners.get(options.entryPath);
  if (current === undefined) {
    options.owners.set(options.entryPath, options.checker);
    return [];
  }
  if (current === options.checker) return [];
  return [
    [
      'Checker ownership conflict:',
      `  entry config: ${toRelativePath(options.config.rootDir, options.entryPath)}`,
      `  checkers: ${current}, ${options.checker}`,
      '  evidence: the entry matched multiple named checker include scopes.',
    ].join('\n'),
  ];
}

function createExplicitOwnerByEntryPath(options: {
  config: ResolvedLiminaInputs;
  selections: readonly ResolvedCheckerEntrySelection[];
  problems: string[];
}): Map<string, CheckerName> {
  const owners = new Map<string, CheckerName>();
  const problems: string[] = [];
  for (const selection of options.selections) {
    for (const entryPath of selection.selection.effectiveEntryPaths) {
      problems.push(
        ...claimExplicitOwner({
          checker: selection.checker.name,
          config: options.config,
          entryPath,
          owners,
        }),
      );
    }
  }
  options.problems.push(...problems);
  return owners;
}

export async function discoverCheckerOwnership(options: {
  cache?: NativeAnalysisCache;
  activatedRegions: WorkspaceRegionPathIndex;
  config: ResolvedLiminaInputs;
  projectConfigCache?: PrepareGeneratedTsconfigGraphOptions['projectConfigCache'];
  workspaceSourceConfigPaths: readonly string[];
  projectDependencyCaches?: ProjectDependencyCaches;
}): Promise<CheckerOwnershipDiscovery> {
  const observer = currentProfile();
  const { namedSelections, activeEntryPaths } = await observeAsyncWork(
    observer,
    'checker-entry-selection',
    () =>
      resolveOwnershipEntries({
        config: options.config,
        sourceConfigPaths: options.workspaceSourceConfigPaths,
      }),
  );
  for (const configPath of activeEntryPaths)
    observer?.project(configPath, { entry: true, seenVia: 'entry-selection' });
  const collectionProblems: string[] = [];
  const inputFailures = new Map<string, Error>();
  const explicitOwnerByEntryPath = createExplicitOwnerByEntryPath({
    problems: collectionProblems,
    config: options.config,
    selections: namedSelections,
  });
  const scopes = observeWork(observer, 'checker-scope-discovery', () =>
    collectOwnershipScopes({
      onInputError: (configPath, error) => {
        if (!inputFailures.has(configPath))
          inputFailures.set(configPath, error);
      },
      onProblems: (problems) => {
        collectionProblems.push(...problems);
      },
      activatedRegions: options.activatedRegions,
      config: options.config,
      entryConfigPaths: activeEntryPaths,
      explicitOwnerByEntryPath,
    }),
  );
  const candidates = createCandidateByConfigPath(scopes);
  const cache = options.cache ?? options.projectDependencyCaches?.analysisCache;
  const plan = createOwnershipPlan({
    directReferences: createDirectSolutionReferences(scopes),
    candidates,
  });
  if (cache !== undefined)
    observeWork(observer, 'cache.package-scope.scan', () =>
      cache.observePackageScopes(
        options.activatedRegions,
        plan.typeConfigs.keys(),
        plan.solutions.keys(),
      ),
    );
  const authorities = observeWork(observer, 'checker-semantic-authority', () =>
    resolveSourceConfigAuthorities({
      cache,
      config: options.config,
      namedSelections,
      plan,
      scopes,
    }),
  );
  collectionProblems.push(...authorities.problems);
  const {
    coverage: sourceCoverage,
    frozenProjectsByConfigPath,
    problems: preparationProblems,
    preparationFailures,
    projectByConfigPath,
    unavailableProjects,
  } = prepareSourceConfigProjects({
    ...options,
    activeEntryPaths,
    cache,
    candidates,
    plan,
    scopes,
  });
  collectionProblems.push(...preparationProblems);
  collectUnavailableSourceDiagnostics({
    coverage: sourceCoverage,
    projectDependencyCaches: options.projectDependencyCaches,
    unavailableProjects,
  });
  const managedEntryPaths = activeEntryPaths.filter(
    (entryPath) =>
      plan.typeConfigs.has(entryPath) || plan.solutions.has(entryPath),
  );
  if (observer !== undefined) {
    for (const configPath of plan.typeConfigs.keys())
      observer.project(configPath, {
        role: 'source',
        seenVia: 'checker-ownership',
      });
    for (const configPath of plan.solutions.keys()) {
      observer.project(configPath, {
        role: 'solution',
        seenVia: 'checker-ownership',
      });
    }
    for (const configPath of inputFailures.keys())
      observer.project(configPath, { seenVia: 'config-input-failure' });
    if (
      inputFailures.size === 0 &&
      collectionProblems.length === 0 &&
      sourceCoverage.universe.discovery !== 'open'
    )
      observer.inventoryComplete();
  }
  registerCoreWork(options.projectDependencyCaches, plan.typeConfigs.keys());
  if (options.projectDependencyCaches !== undefined) {
    for (const [configPath, error] of inputFailures) {
      retainAnalysisFailure(options.projectDependencyCaches, error, configPath);
      recordCoreWork(options.projectDependencyCaches, {
        configPath,
        phase: 'selection',
        family: 'unselected',
        eligibility: 'eligible',
        execution: 'failed',
        reason: error.message,
      });
    }
    for (const entry of activeEntryPaths) {
      if (
        plan.typeConfigs.has(entry) ||
        plan.solutions.has(entry) ||
        (collectionProblems.length === 0 && inputFailures.size === 0)
      )
        continue;
      recordCoreWork(options.projectDependencyCaches, {
        configPath: entry,
        phase: 'locked',
        family: 'unselected',
        eligibility: 'unavailable',
        execution: 'not-run',
        reason: 'authority-unavailable',
      });
    }
  }
  return {
    ambiguities: authorities.ambiguities.filter(({ sourceConfigPath }) =>
      plan.typeConfigs.has(sourceConfigPath),
    ),
    collectionInputFailure: inputFailures.values().next().value,
    collectionProblems,
    sourceConfigCoverage: sourceCoverage,
    activatedRegions: options.activatedRegions,
    activeEntryPaths: managedEntryPaths,
    autoChecker: getAutoCheckerConfig(options.config.scope?.checkers).useTsgo
      ? 'tsgo'
      : 'tsc',
    explicitOwnerByEntryPath,
    plan,
    projectByConfigPath,
    frozenProjectsByConfigPath,
    preparationFailures,
    scopes,
  };
}

export function createOwnershipSelections(options: {
  discovery: CheckerOwnershipDiscovery;
  config: ResolvedLiminaInputs;
}): ResolvedCheckerEntrySelection[] {
  const entriesByChecker = new Map<CheckerName, string[]>();
  for (const state of options.discovery.plan.typeConfigs.values()) {
    if (state.finalOwner === undefined)
      throw new Error(`Missing source owner: ${state.configPath}`);
    addCheckerEntry(entriesByChecker, state.finalOwner, state.configPath);
  }
  return [...entriesByChecker]
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([name, entries]) => {
      entries.sort(compareCodeUnits);
      const origins = [...options.discovery.plan.sourceConfigPathsByEntry]
        .filter(([, sources]) =>
          sources.some(
            (source) =>
              options.discovery.plan.typeConfigs.get(source)?.finalOwner ===
              name,
          ),
        )
        .map(([entry]) => entry)
        .sort(compareCodeUnits);
      return {
        sourceConfigPaths: entries,
        checker: createResolvedChecker({
          entries: origins,
          name,
          rootDir: options.config.rootDir,
        }),
        selection: {
          effectiveEntryPaths: origins,
          includedEntryPaths: origins,
        },
      };
    });
}

function addCheckerEntry(
  entriesByChecker: Map<CheckerName, string[]>,
  checker: CheckerName,
  entryPath: string,
): void {
  const entries = entriesByChecker.get(checker);
  if (entries === undefined) {
    entriesByChecker.set(checker, [entryPath]);
    return;
  }
  entries.push(entryPath);
}

function registerCoreWork(
  caches: ProjectDependencyCaches | undefined,
  configs: Iterable<string>,
): void {
  if (caches === undefined) return;
  for (const configPath of configs) {
    recordCoreWork(caches, {
      configPath,
      phase: 'locked',
      family: 'unselected',
      eligibility: 'unavailable',
      execution: 'not-run',
      reason: 'authority-unavailable',
    });
  }
}
