import type { CheckerName, ResolvedLiminaInputs } from '#config/runner';
import path from 'pathe';
import ts from 'typescript';
import { createProjectParseHost } from '../../checker/project-base';
import type { WorkspaceRegionPathIndex } from '../workspace/validated-context';
import type { SourceConfigCandidate } from './auto-checker-types';
import { applyConfigEvidence } from './checker-ownership-config-evidence';
import { resolveOwnershipEntries } from './checker-ownership-entries';
import { applyExplicitRequirements } from './checker-ownership-evidence';
import {
  collectOwnershipScopes,
  createCandidateByConfigPath,
  createDirectSolutionReferences,
  createOwnershipPlan,
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
    scope.frameworkEvidence.some((evidence) =>
      evidence.intentHints.some((hint) => hint.family === 'svelte'),
    )
  );
}

function hasMissingRelativeExtends(
  candidates: Iterable<SourceConfigCandidate>,
  virtualFiles: ResolvedLiminaInputs['virtualFiles'],
): boolean {
  const { fileExists } = createProjectParseHost(virtualFiles);
  for (const { configObject, configPath } of candidates) {
    const value = configObject.extends;
    const specifiers = Array.isArray(value) ? value : [value];
    for (const specifier of specifiers) {
      if (
        typeof specifier !== 'string' ||
        !ts.isExternalModuleNameRelative(specifier)
      )
        continue;
      const base = path.resolve(path.dirname(configPath), specifier);
      if (
        !fileExists(base) &&
        (base.endsWith('.json') || !fileExists(`${base}.json`))
      )
        return true;
    }
  }
  return false;
}

/**
Only excludes Svelte routing; it grants no graph or execution authority.
Dependency propagation cannot create a first Svelte owner without a local seed.
Any incomplete or conflicting discovery stays with the full ownership resolver.
*/
export async function canExcludeSvelteProjects(options: {
  config: ResolvedLiminaInputs;
  activatedRegions: WorkspaceRegionPathIndex;
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
    const scopes = collectOwnershipScopes({
      ...options,
      entryConfigPaths: activeEntryPaths,
      explicitOwnerByEntryPath,
      onProblems: (items) => {
        problems.push(...items);
      },
    });
    if (problems.length > 0 || scopes.some(hasSvelteSeed)) return false;
    const candidates = createCandidateByConfigPath(scopes);
    if (
      hasMissingRelativeExtends(
        candidates.values(),
        options.config.virtualFiles,
      )
    )
      return false;
    const plan = createOwnershipPlan({
      directReferences: createDirectSolutionReferences(scopes),
      candidates,
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
    );
    return problems.length === 0;
  } catch {
    return false;
  }
}
