import { CheckerProjectConfigCache } from '#checkers';
import type { CheckerName, ResolvedLiminaInputs } from '#config/runner';
import type { WorkspaceRegionPathIndex } from '../workspace/validated-context';
import { applyConfigEvidence } from './checker-ownership-config-evidence';
import { resolveOwnershipEntries } from './checker-ownership-entries';
import {
  applyExplicitRequirements,
  applyRootFileEvidence,
} from './checker-ownership-evidence';
import {
  collectOwnershipScopes,
  createDirectSolutionReferences,
  createOwnershipPlan,
  createProjectByConfigPath,
} from './checker-ownership-graph';
import type { AutoScope, ResolvedCheckerEntrySelection } from './types';

function collectExplicitOwners(
  selections: readonly ResolvedCheckerEntrySelection[],
): Map<string, CheckerName> | undefined {
  const owners = new Map<string, CheckerName>();
  for (const { checker, selection } of selections) {
    for (const entry of selection.effectiveEntryPaths) {
      const current = owners.get(entry);
      if (current !== undefined && current !== checker.name) return undefined;
      owners.set(entry, checker.name);
    }
  }
  return owners;
}

function hasSvelteSeed(scope: AutoScope): boolean {
  return (
    scope.authoritativeChecker === 'svelte-check' ||
    scope.projects.some(
      (project) => project.filePartition.svelteFiles.length > 0,
    ) ||
    scope.frameworkEvidence.some((evidence) =>
      evidence.intentHints.some((hint) => hint.family === 'svelte'),
    )
  );
}

/**
Only excludes Svelte routing; it grants no graph or execution authority.
Dependency propagation cannot create a first Svelte owner without a local seed.
Any incomplete or conflicting discovery stays with the full ownership resolver.
*/
export async function canExcludeSvelteProjects(options: {
  config: ResolvedLiminaInputs;
  activatedRegions: WorkspaceRegionPathIndex;
  generation: number;
  workspaceSourceConfigPaths: readonly string[];
}): Promise<boolean> {
  try {
    const { namedSelections, activeEntryPaths } = await resolveOwnershipEntries(
      {
        config: options.config,
        sourceConfigPaths: options.workspaceSourceConfigPaths,
      },
    );
    const explicitOwnerByEntryPath = collectExplicitOwners(namedSelections);
    if (explicitOwnerByEntryPath === undefined) return false;
    const problems: string[] = [];
    // Route discovery must not cache file membership for authoritative analysis.
    const projectConfigCache = new CheckerProjectConfigCache(
      options.generation,
    );
    const scopes = collectOwnershipScopes({
      ...options,
      projectConfigCache,
      entryConfigPaths: activeEntryPaths,
      explicitOwnerByEntryPath,
      onProblems: (items) => {
        problems.push(...items);
      },
    });
    if (problems.length > 0 || scopes.some(hasSvelteSeed)) return false;
    const projectByConfigPath = createProjectByConfigPath(scopes);
    const plan = createOwnershipPlan({
      directReferences: createDirectSolutionReferences(scopes),
      projectByConfigPath,
    });
    for (const { checker, selection } of namedSelections) {
      const entryOwners = new Map(
        selection.effectiveEntryPaths.map((entry) => [entry, checker.name]),
      );
      problems.push(
        ...applyExplicitRequirements({
          config: options.config,
          explicitOwnerByEntryPath: entryOwners,
          plan,
        }),
      );
    }
    problems.push(
      ...applyConfigEvidence({ config: options.config, plan, scopes }),
      ...applyRootFileEvidence({
        config: options.config,
        plan,
        projectByConfigPath,
      }),
    );
    return problems.length === 0;
  } catch {
    return false;
  }
}
