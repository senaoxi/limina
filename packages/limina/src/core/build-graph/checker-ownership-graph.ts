import type { CheckerProjectConfigCache } from '#checkers';
import type { CheckerName, ResolvedLiminaConfig } from '#config/runner';
import { compareCodeUnits } from '#utils/collections';
import type { WorkspaceRegionPathIndex } from '../workspace/validated-context';
import { collectAutoScope, collectExplicitScope } from './auto-checker-scope';
import type { AutoScopeProject } from './auto-checker-types';
import type {
  CheckerOwnershipPlan,
  SolutionOwnershipState,
  TypeConfigOwnershipState,
} from './checker-ownership-types';
import { createPendingSemanticAuthority } from './checker-semantic-authority';
import type { AutoScope } from './types';

export function collectOwnershipScopes(options: {
  activatedRegions: WorkspaceRegionPathIndex;
  config: ResolvedLiminaConfig;
  entryConfigPaths: readonly string[];
  explicitOwnerByEntryPath: ReadonlyMap<string, CheckerName>;
  projectConfigCache?: CheckerProjectConfigCache;
}): AutoScope[] {
  return options.entryConfigPaths.flatMap((entryConfigPath) => {
    const explicitChecker =
      options.explicitOwnerByEntryPath.get(entryConfigPath);
    const scope =
      explicitChecker === undefined
        ? collectAutoScope({ ...options, entryConfigPath })
        : collectExplicitScope({
            ...options,
            checkerName: explicitChecker,
            entryConfigPath,
          });
    return scope === null ? [] : [scope];
  });
}

function sameProjectShape(
  left: AutoScopeProject,
  right: AutoScopeProject,
): boolean {
  return (
    left.fileNames.length === right.fileNames.length &&
    left.fileNames.every(
      (fileName, index) => right.fileNames[index] === fileName,
    )
  );
}

export function createProjectByConfigPath(
  scopes: readonly AutoScope[],
): Map<string, AutoScopeProject> {
  const projects = new Map<string, AutoScopeProject>();
  const authoritativePaths = collectAuthoritativeConfigPaths(scopes);
  for (const scope of [...scopes].sort(compareScopeAuthority)) {
    addScopeProjects({ authoritativePaths, projects, scope });
  }
  return projects;
}

function addScopeProjects(options: {
  authoritativePaths: ReadonlySet<string>;
  projects: Map<string, AutoScopeProject>;
  scope: AutoScope;
}): void {
  for (const project of options.scope.projects) {
    const current = options.projects.get(project.configPath);
    if (
      shouldKeepAuthoritativeProject(
        current,
        project,
        options.authoritativePaths,
      )
    )
      continue;
    assertConsistentProjectShape(current, project);
    options.projects.set(project.configPath, project);
  }
}

function shouldKeepAuthoritativeProject(
  current: AutoScopeProject | undefined,
  incoming: AutoScopeProject,
  authoritativePaths: ReadonlySet<string>,
): boolean {
  return current !== undefined && authoritativePaths.has(incoming.configPath);
}

function compareScopeAuthority(left: AutoScope, right: AutoScope): number {
  return (
    Number(right.authoritativeChecker !== undefined) -
    Number(left.authoritativeChecker !== undefined)
  );
}

function collectScopeConfigPaths(scope: AutoScope): string[] {
  return [
    ...scope.collection.projectConfigPaths,
    ...scope.collection.solutionConfigPaths,
  ];
}

function collectAuthoritativeConfigPaths(
  scopes: readonly AutoScope[],
): Set<string> {
  return new Set(
    scopes.flatMap((scope) =>
      scope.authoritativeChecker === undefined
        ? []
        : collectScopeConfigPaths(scope),
    ),
  );
}

function assertConsistentProjectShape(
  current: AutoScopeProject | undefined,
  incoming: AutoScopeProject,
): void {
  if (current === undefined || sameProjectShape(current, incoming)) return;
  throw new Error(
    `Checker ownership discovery observed inconsistent effective files for ${incoming.configPath}.`,
  );
}

function addSolutionReferences(
  references: Map<string, Set<string>>,
  solutionPath: string,
  targetPaths: readonly string[],
): void {
  const values = references.get(solutionPath);
  if (values === undefined) {
    references.set(solutionPath, new Set(targetPaths));
    return;
  }
  for (const targetPath of targetPaths) values.add(targetPath);
}

export function createDirectSolutionReferences(
  scopes: readonly AutoScope[],
): Map<string, string[]> {
  const references = new Map<string, Set<string>>();
  const authoritativePaths = collectAuthoritativeConfigPaths(scopes);
  for (const scope of [...scopes].sort(compareScopeAuthority)) {
    addScopeSolutionReferences({ authoritativePaths, references, scope });
  }
  return new Map(
    [...references].map(([solutionPath, targetPaths]) => [
      solutionPath,
      [...targetPaths].sort(compareCodeUnits),
    ]),
  );
}

function addScopeSolutionReferences(options: {
  authoritativePaths: ReadonlySet<string>;
  references: Map<string, Set<string>>;
  scope: AutoScope;
}): void {
  for (const [solutionPath, targetPaths] of options.scope.collection
    .solutionReferencesBySourcePath) {
    if (
      shouldSkipAutoSolution(
        options.scope,
        solutionPath,
        options.authoritativePaths,
      )
    )
      continue;
    addSolutionReferences(options.references, solutionPath, targetPaths);
  }
}

function shouldSkipAutoSolution(
  scope: AutoScope,
  solutionPath: string,
  authoritativePaths: ReadonlySet<string>,
): boolean {
  return (
    scope.authoritativeChecker === undefined &&
    authoritativePaths.has(solutionPath)
  );
}

interface LeafTraversal {
  directReferences: ReadonlyMap<string, string[]>;
  leaves: Set<string>;
  projectByConfigPath: ReadonlyMap<string, AutoScopeProject>;
  visited: Set<string>;
  visiting: Set<string>;
}

function addProjectLeaf(traversal: LeafTraversal, configPath: string): boolean {
  if (!traversal.projectByConfigPath.has(configPath)) return false;
  traversal.leaves.add(configPath);
  return true;
}

function shouldSkipVisit(
  traversal: LeafTraversal,
  configPath: string,
): boolean {
  if (addProjectLeaf(traversal, configPath)) return true;
  return traversal.visited.has(configPath);
}

function assertNotVisiting(traversal: LeafTraversal, configPath: string): void {
  if (!traversal.visiting.has(configPath)) return;
  throw new Error(`Circular solution references reach ${configPath}.`);
}

function visitSolutionConfig(
  traversal: LeafTraversal,
  configPath: string,
): void {
  if (shouldSkipVisit(traversal, configPath)) return;
  assertNotVisiting(traversal, configPath);
  traversal.visiting.add(configPath);
  for (const targetPath of getDirectReferences(traversal, configPath)) {
    visitSolutionConfig(traversal, targetPath);
  }
  traversal.visiting.delete(configPath);
  traversal.visited.add(configPath);
}

function getDirectReferences(
  traversal: LeafTraversal,
  configPath: string,
): string[] {
  return traversal.directReferences.get(configPath) ?? [];
}

function collectSolutionLeaves(options: {
  directReferences: ReadonlyMap<string, string[]>;
  projectByConfigPath: ReadonlyMap<string, AutoScopeProject>;
  solutionPath: string;
}): string[] {
  const traversal: LeafTraversal = {
    ...options,
    leaves: new Set(),
    visited: new Set(),
    visiting: new Set(),
  };
  visitSolutionConfig(traversal, options.solutionPath);
  return [...traversal.leaves].sort(compareCodeUnits);
}

function createTypeState(configPath: string): TypeConfigOwnershipState {
  return {
    configPath,
    constraintCandidates: new Map(),
    evidence: [],
    kind: 'type',
    localOwner: { kind: 'pending' },
    semanticAuthority: createPendingSemanticAuthority(),
  };
}

export function createOwnershipPlan(options: {
  directReferences: ReadonlyMap<string, string[]>;
  projectByConfigPath: ReadonlyMap<string, AutoScopeProject>;
}): CheckerOwnershipPlan {
  const typeConfigs = new Map(
    [...options.projectByConfigPath.keys()].map((configPath) => [
      configPath,
      createTypeState(configPath),
    ]),
  );
  const solutions = new Map<string, SolutionOwnershipState>();
  for (const solutionPath of options.directReferences.keys()) {
    solutions.set(solutionPath, {
      configPath: solutionPath,
      constraintCandidates: new Map(),
      kind: 'solution',
      leafConfigPaths: collectSolutionLeaves({ ...options, solutionPath }),
    });
  }
  return {
    dependencyFacts: [],
    entryOwnerByConfigPath: new Map(),
    solutions,
    typeConfigs,
  };
}
