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
import type { ProjectDependencyCaches } from '../project-dependencies/contracts';
import type { WorkspaceRegionPathIndex } from '../workspace/validated-context';
import type { AutoScopeProject } from './auto-checker-types';
import { applyConfigEvidence } from './checker-ownership-config-evidence';
import { resolveOwnershipEntries } from './checker-ownership-entries';
import { applyExplicitRequirements } from './checker-ownership-evidence';
import {
  collectOwnershipScopes,
  createDirectSolutionReferences,
  createOwnershipPlan,
  createProjectByConfigPath,
} from './checker-ownership-graph';
import type { CheckerOwnershipPlan } from './checker-ownership-types';
import { recordCoreWork } from './core-collection-run';
import { prepareNativeSourceBaseline } from './native-source-baseline';
import type {
  AutoScope,
  PrepareGeneratedTsconfigGraphOptions,
  ResolvedCheckerEntrySelection,
} from './types';

export interface CheckerOwnershipDiscovery {
  collectionProblems?: string[];
  sourceConfigCoverage?: SourceConfigCoverageIndex;
  activatedRegions?: WorkspaceRegionPathIndex;
  activeEntryPaths: string[];
  autoChecker: 'tsc' | 'tsgo';
  explicitOwnerByEntryPath: Map<string, CheckerName>;
  plan: CheckerOwnershipPlan;
  projectByConfigPath: Map<string, AutoScopeProject>;
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
  const baseline = prepareNativeSourceBaseline({
    ...options,
    entries: activeEntryPaths,
  });
  const collectionProblems: string[] = [];
  const explicitOwnerByEntryPath = createExplicitOwnerByEntryPath({
    problems: collectionProblems,
    config: options.config,
    selections: namedSelections,
  });
  const scopes = collectOwnershipScopes({
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
  const plan = createOwnershipPlan({
    directReferences: createDirectSolutionReferences(scopes),
    projectByConfigPath,
  });
  const managedEntryPaths = activeEntryPaths.filter(
    (entryPath) =>
      plan.typeConfigs.has(entryPath) || plan.solutions.has(entryPath),
  );
  collectionProblems.push(
    ...namedSelections.flatMap((selection) =>
      applyExplicitRequirements({
        config: options.config,
        explicitOwnerByEntryPath: new Map(
          selection.selection.effectiveEntryPaths.map((entry) => [
            entry,
            selection.checker.name,
          ]),
        ),
        plan,
      }),
    ),
    ...applyConfigEvidence({ config: options.config, plan, scopes }),
  );
  registerCoreWork(options.projectDependencyCaches, projectByConfigPath);
  return {
    collectionProblems,
    sourceConfigCoverage: baseline.coverageIndexes[0],
    activatedRegions: options.activatedRegions,
    activeEntryPaths: managedEntryPaths,
    autoChecker: getAutoCheckerConfig(options.config.scope?.checkers).useTsgo
      ? 'tsgo'
      : 'tsc',
    explicitOwnerByEntryPath,
    plan,
    projectByConfigPath,
    scopes,
  };
}

export function createOwnershipSelections(options: {
  discovery: CheckerOwnershipDiscovery;
  config: ResolvedLiminaInputs;
}): ResolvedCheckerEntrySelection[] {
  const entriesByChecker = new Map<CheckerName, string[]>();
  for (const entryPath of options.discovery.activeEntryPaths) {
    const checker = getRequiredEntryChecker(options.discovery.plan, entryPath);
    addCheckerEntry(entriesByChecker, checker, entryPath);
  }
  return [...entriesByChecker]
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([name, entries]) => {
      entries.sort(compareCodeUnits);
      return {
        checker: createResolvedChecker({
          entries,
          name,
          rootDir: options.config.rootDir,
        }),
        selection: {
          effectiveEntryPaths: entries,
          includedEntryPaths: entries,
        },
      };
    });
}

function getRequiredEntryChecker(
  plan: CheckerOwnershipPlan,
  entryPath: string,
): CheckerName {
  const checker = plan.entryOwnerByConfigPath.get(entryPath);
  if (checker !== undefined) return checker;
  throw new Error(`Missing final checker owner for entry ${entryPath}.`);
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
      phase: 'selection',
      family: 'pending',
      eligibility: 'eligible',
      execution: 'not-run',
    });
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
