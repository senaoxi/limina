import { getCheckerExtensions } from '#checkers';
import {
  type CheckerName,
  getActiveCheckers,
  getAutoCheckerConfig,
  type ResolvedCheckerConfig,
  type ResolvedLiminaConfig,
} from '#config/runner';
import { compareCodeUnits } from '#utils/collections';
import { toPosixPath, toRelativePath } from '#utils/path';
import {
  createCheckerEntrySelectionOptions,
  resolveCheckerEntrySelection,
} from '../checkers/entry-selection';
import type { WorkspaceRegionPathIndex } from '../workspace/validated-context';
import type { AutoScopeProject } from './auto-checker-types';
import { applyConfigEvidence } from './checker-ownership-config-evidence';
import { applyExplicitRequirements } from './checker-ownership-evidence';
import {
  collectOwnershipScopes,
  createDirectSolutionReferences,
  createOwnershipPlan,
  createProjectByConfigPath,
} from './checker-ownership-graph';
import type { CheckerOwnershipPlan } from './checker-ownership-types';
import { createGeneratedGraphStructuredError } from './problems';
import type {
  AutoScope,
  PrepareGeneratedTsconfigGraphOptions,
  ResolvedCheckerEntrySelection,
} from './types';

export interface CheckerOwnershipDiscovery {
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

async function collectNamedSelections(options: {
  config: ResolvedLiminaConfig;
  sourceConfigPaths: readonly string[];
}): Promise<ResolvedCheckerEntrySelection[]> {
  return Promise.all(
    getActiveCheckers(options.config).map(async (checker) => ({
      checker,
      selection: await resolveCheckerEntrySelection(
        {
          config: options.config,
          sourceConfigPaths: options.sourceConfigPaths,
        },
        createCheckerEntrySelectionOptions(checker),
      ),
    })),
  );
}

function claimExplicitOwner(options: {
  checker: CheckerName;
  config: ResolvedLiminaConfig;
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
  config: ResolvedLiminaConfig;
  selections: readonly ResolvedCheckerEntrySelection[];
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
  throwOwnershipProblems({
    config: options.config,
    fallback: 'Failed to assign named checker entry ownership.',
    problems,
  });
  return owners;
}

async function collectAutoEntryPaths(options: {
  config: ResolvedLiminaConfig;
  sourceConfigPaths: readonly string[];
}): Promise<string[]> {
  const auto = getAutoCheckerConfig(options.config.config?.checkers);
  const selection = await resolveCheckerEntrySelection(
    {
      config: options.config,
      sourceConfigPaths: options.sourceConfigPaths,
    },
    {
      checkerName: '__auto__',
      exclude: auto.exclude ?? [],
      include: ['**/tsconfig.json'],
    },
  );
  return selection.effectiveEntryPaths;
}

function collectActiveEntryPaths(options: {
  autoEntryPaths: readonly string[];
  namedSelections: readonly ResolvedCheckerEntrySelection[];
}): string[] {
  return [
    ...new Set([
      ...options.autoEntryPaths,
      ...options.namedSelections.flatMap(
        (selection) => selection.selection.effectiveEntryPaths,
      ),
    ]),
  ].sort(compareCodeUnits);
}

function throwOwnershipProblems(options: {
  config: ResolvedLiminaConfig;
  fallback: string;
  problems: string[];
}): void {
  if (options.problems.length === 0) return;
  throw createGeneratedGraphStructuredError(options);
}

export async function discoverCheckerOwnership(options: {
  activatedRegions: WorkspaceRegionPathIndex;
  config: ResolvedLiminaConfig;
  projectConfigCache?: PrepareGeneratedTsconfigGraphOptions['projectConfigCache'];
  workspaceSourceConfigPaths: readonly string[];
}): Promise<CheckerOwnershipDiscovery> {
  const namedSelections = await collectNamedSelections({
    config: options.config,
    sourceConfigPaths: options.workspaceSourceConfigPaths,
  });
  const explicitOwnerByEntryPath = createExplicitOwnerByEntryPath({
    config: options.config,
    selections: namedSelections,
  });
  const activeEntryPaths = collectActiveEntryPaths({
    autoEntryPaths: await collectAutoEntryPaths({
      config: options.config,
      sourceConfigPaths: options.workspaceSourceConfigPaths,
    }),
    namedSelections,
  });
  const scopes = collectOwnershipScopes({
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
  throwOwnershipProblems({
    config: options.config,
    fallback: 'Failed to resolve checker config evidence.',
    problems: [
      ...applyExplicitRequirements({
        config: options.config,
        explicitOwnerByEntryPath,
        plan,
      }),
      ...applyConfigEvidence({ config: options.config, plan, scopes }),
    ],
  });
  return {
    activeEntryPaths: managedEntryPaths,
    autoChecker: getAutoCheckerConfig(options.config.config?.checkers).useTsgo
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
  config: ResolvedLiminaConfig;
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
