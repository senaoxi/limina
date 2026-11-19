import { getCheckerExtensions } from '#checkers';
import {
  type CheckerName,
  getAutoCheckerConfig,
  type ResolvedCheckerConfig,
  type ResolvedLiminaInputs,
} from '#config/runner';
import { compareCodeUnits } from '#utils/collections';
import { toPosixPath, toRelativePath } from '#utils/path';
import type { SourceConfigCoverageIndex } from '../../domain/analysis/native-coverage';
import type { NativeAnalysisCache } from '../analysis-cache/native-cache';
import type { ProjectDependencyCaches } from '../project-dependencies/contracts';
import type { WorkspaceRegionPathIndex } from '../workspace/validated-context';
import { retainAnalysisFailure } from './analysis-failure';
import type { AutoScopeProject } from './auto-checker-types';
import { resolveOwnershipEntries } from './checker-ownership-entries';
import {
  collectOwnershipScopes,
  createDirectSolutionReferences,
  createOwnershipPlan,
  createProjectByConfigPath,
} from './checker-ownership-graph';
import type { CheckerOwnershipPlan } from './checker-ownership-types';
import type { FrameworkInferenceAmbiguity } from './core-collection-run';
import { recordCoreWork } from './core-collection-run';
import type { FrozenSemanticProject } from './locked-semantic-project';
import { prepareNativeSourceBaseline } from './native-source-baseline';
import { resolveSourceConfigAuthorities } from './source-config-authorities';
import type {
  AutoScope,
  PrepareGeneratedTsconfigGraphOptions,
  ResolvedCheckerEntrySelection,
} from './types';

export interface CheckerOwnershipDiscovery {
  authoritiesComplete?: boolean;
  ambiguities?: readonly FrameworkInferenceAmbiguity[];
  collectionInputFailure?: Error;
  collectionProblems?: string[];
  sourceConfigCoverage?: SourceConfigCoverageIndex;
  activatedRegions?: WorkspaceRegionPathIndex;
  activeEntryPaths: string[];
  autoChecker: 'tsc' | 'tsgo';
  explicitOwnerByEntryPath: Map<string, CheckerName>;
  plan: CheckerOwnershipPlan;
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
  restoreOnly?: boolean;
  activatedRegions: WorkspaceRegionPathIndex;
  config: ResolvedLiminaInputs;
  projectConfigCache?: PrepareGeneratedTsconfigGraphOptions['projectConfigCache'];
  workspaceSourceConfigPaths: readonly string[];
  projectDependencyCaches?: ProjectDependencyCaches;
}): Promise<CheckerOwnershipDiscovery> {
  const { namedSelections, activeEntryPaths } = await resolveOwnershipEntries({
    config: options.config,
    sourceConfigPaths: options.workspaceSourceConfigPaths,
  });
  const collectionProblems: string[] = [];
  const inputFailures = new Map<string, Error>();
  const explicitOwnerByEntryPath = createExplicitOwnerByEntryPath({
    problems: collectionProblems,
    config: options.config,
    selections: namedSelections,
  });
  const scopes = collectOwnershipScopes({
    onInputError: (configPath, error) => {
      if (!inputFailures.has(configPath)) inputFailures.set(configPath, error);
    },
    onProblems: (problems) => {
      collectionProblems.push(...problems);
    },
    activatedRegions: options.activatedRegions,
    config: options.config,
    entryConfigPaths: activeEntryPaths,
    explicitOwnerByEntryPath,
    projectConfigCache: options.projectConfigCache,
  });
  const projectByConfigPath = createProjectByConfigPath(scopes);
  const cache = options.cache ?? options.projectDependencyCaches?.analysisCache;
  for (const project of projectByConfigPath.values()) {
    cache?.observeProjectLock(project.configPath);
    cache?.inputs.observeConfig(project.configClosure, project.virtualFiles);
  }
  const plan = createOwnershipPlan({
    directReferences: createDirectSolutionReferences(scopes),
    projectByConfigPath,
  });
  const authorities = resolveSourceConfigAuthorities({
    restoreOnly: options.restoreOnly,
    cache,
    config: options.config,
    namedSelections,
    plan,
    projects: projectByConfigPath,
    scopes,
  });
  collectionProblems.push(...authorities.problems);
  const baseline = options.restoreOnly
    ? undefined
    : prepareNativeSourceBaseline({
        ...options,
        entries: activeEntryPaths,
        discoveredProjects: projectByConfigPath,
      });
  const sourceCoverage = baseline?.coverageIndexes[0];
  const enumerations = sourceCoverage?.configurations ?? [];
  for (const enumeration of enumerations) {
    if (
      enumeration.state === 'enumerated' &&
      enumeration.members.length > 0 &&
      !inputFailures.has(enumeration.configId) &&
      !plan.typeConfigs.has(enumeration.configId) &&
      !plan.solutions.has(enumeration.configId)
    ) {
      collectionProblems.push(
        `Selected source config has no ownership result: ${enumeration.configId}`,
      );
    }
  }
  const managedEntryPaths = activeEntryPaths.filter(
    (entryPath) =>
      plan.typeConfigs.has(entryPath) || plan.solutions.has(entryPath),
  );
  registerCoreWork(options.projectDependencyCaches, projectByConfigPath);
  if (options.projectDependencyCaches !== undefined) {
    for (const [configPath, error] of inputFailures) {
      const retained = baseline?.failures.some(
        (failure) =>
          failure.kind === 'config-parse' &&
          failure.evidenceIds.includes(configPath),
      );
      if (!retained)
        retainAnalysisFailure(
          options.projectDependencyCaches,
          error,
          configPath,
        );
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
    authoritiesComplete: authorities.complete,
    ambiguities: authorities.ambiguities,
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
    frozenProjectsByConfigPath: new Map(),
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
  projects: CheckerOwnershipDiscovery['projectByConfigPath'],
): void {
  if (caches === undefined) return;
  for (const configPath of projects.keys()) {
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
