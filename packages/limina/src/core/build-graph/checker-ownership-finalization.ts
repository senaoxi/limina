import type { CheckerName, ResolvedLiminaConfig } from '#config/runner';
import { compareCodeUnits } from '#utils/collections';
import { toRelativePath } from '#utils/path';
import type { CheckerOwnershipDiscovery } from './checker-ownership-discovery';
import { assertOwnershipPhase } from './checker-ownership-evidence';
import type {
  SolutionOwnershipState,
  TypeConfigOwnershipState,
} from './checker-ownership-types';
import {
  getUniqueConstraint,
  propagateSolutionConstraints,
} from './checker-solution-constraints';

export function validateOwnershipConstraints(options: {
  config: ResolvedLiminaConfig;
  discovery: CheckerOwnershipDiscovery;
  phase: string;
}): void {
  assertOwnershipPhase({
    config: options.config,
    fallback: `Checker ownership conflict after ${options.phase}.`,
    problems: propagateSolutionConstraints({
      plan: options.discovery.plan,
      rootDir: options.config.rootDir,
    }),
  });
}

function setFinalOwner(options: {
  checker: CheckerName;
  detail: string;
  source: 'fallback' | 'solution-constraint';
  state: TypeConfigOwnershipState;
}): void {
  options.state.finalOwner = options.checker;
  options.state.evidence.push({
    checker: options.checker,
    configPath: options.state.configPath,
    detail: options.detail,
    source: options.source,
  });
}

function finalizeTypeOwner(
  state: TypeConfigOwnershipState,
  fallback: 'tsc' | 'tsgo',
): void {
  if (state.localOwner.kind === 'resolved') {
    state.finalOwner = state.localOwner.checker;
    return;
  }
  const constraint = getUniqueConstraint(state);
  if (constraint !== undefined) {
    setFinalOwner({
      checker: constraint,
      detail: 'inherited the unique containing solution constraint',
      source: 'solution-constraint',
      state,
    });
    return;
  }
  setFinalOwner({
    checker: fallback,
    detail: 'ordinary TypeScript fallback after framework discovery',
    source: 'fallback',
    state,
  });
}

function finalizeTypeOwners(discovery: CheckerOwnershipDiscovery): void {
  for (const state of discovery.plan.typeConfigs.values()) {
    finalizeTypeOwner(state, discovery.autoChecker);
  }
}

function collectSolutionOwners(
  solution: SolutionOwnershipState,
  discovery: CheckerOwnershipDiscovery,
): Set<CheckerName> {
  return new Set(
    solution.leafConfigPaths.flatMap((leafPath) => {
      const owner = discovery.plan.typeConfigs.get(leafPath)?.finalOwner;
      return owner === undefined ? [] : [owner];
    }),
  );
}

function finalizeSolution(options: {
  config: ResolvedLiminaConfig;
  discovery: CheckerOwnershipDiscovery;
  solution: SolutionOwnershipState;
}): string[] {
  const owners = collectSolutionOwners(options.solution, options.discovery);
  if (owners.size === 1) {
    options.solution.finalOwner = owners.values().next().value;
    return [];
  }
  return [
    [
      'Checker ownership conflict:',
      `  solution: ${toRelativePath(options.config.rootDir, options.solution.configPath)}`,
      `  final leaf owners: ${[...owners].sort(compareCodeUnits).join(', ') || '(none)'}`,
      '  reason: every terminal leaf in a solution closure must have one identical final checker owner.',
    ].join('\n'),
  ];
}

function finalizeSolutions(options: {
  config: ResolvedLiminaConfig;
  discovery: CheckerOwnershipDiscovery;
}): string[] {
  return [...options.discovery.plan.solutions.values()].flatMap((solution) =>
    finalizeSolution({ ...options, solution }),
  );
}

function getEntryOwner(
  discovery: CheckerOwnershipDiscovery,
  entryPath: string,
): CheckerName | undefined {
  const solutionOwner = getStateFinalOwner(
    discovery.plan.solutions.get(entryPath),
  );
  if (solutionOwner !== undefined) return solutionOwner;
  return getStateFinalOwner(discovery.plan.typeConfigs.get(entryPath));
}

function getStateFinalOwner(
  state: { finalOwner?: CheckerName } | undefined,
): CheckerName | undefined {
  return state?.finalOwner;
}

function finalizeEntryOwner(options: {
  config: ResolvedLiminaConfig;
  discovery: CheckerOwnershipDiscovery;
  entryPath: string;
}): string[] {
  const checker = getEntryOwner(options.discovery, options.entryPath);
  if (checker !== undefined) {
    options.discovery.plan.entryOwnerByConfigPath.set(
      options.entryPath,
      checker,
    );
    return [];
  }
  return [
    [
      'Missing final checker owner:',
      `  entry config: ${toRelativePath(options.config.rootDir, options.entryPath)}`,
      '  reason: the active entry has neither a resolved type owner nor a valid solution closure owner.',
    ].join('\n'),
  ];
}

function finalizeEntryOwners(options: {
  config: ResolvedLiminaConfig;
  discovery: CheckerOwnershipDiscovery;
}): void {
  assertOwnershipPhase({
    config: options.config,
    fallback: 'Failed to finalize checker entry ownership.',
    problems: options.discovery.activeEntryPaths.flatMap((entryPath) =>
      finalizeEntryOwner({ ...options, entryPath }),
    ),
  });
}

export function finalizeOwnership(options: {
  config: ResolvedLiminaConfig;
  discovery: CheckerOwnershipDiscovery;
}): void {
  finalizeTypeOwners(options.discovery);
  validateOwnershipConstraints({ ...options, phase: 'TypeScript fallback' });
  assertOwnershipPhase({
    config: options.config,
    fallback: 'Failed to finalize solution checker ownership.',
    problems: finalizeSolutions(options),
  });
  finalizeEntryOwners(options);
}
