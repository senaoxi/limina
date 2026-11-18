import type { CheckerProjectConfigCache } from '#checkers';
import type { ResolvedLiminaInputs } from '#config/runner';
import { compareCodeUnits } from '#utils/collections';
import type { DeclarationContextDecision } from '../../domain/analysis/declaration-context';
import type { ImportAnalysisContext } from '../import-analysis/runner';
import type { ProjectDependencyCaches } from '../project-dependencies/contracts';
import { createProjectDependencyCaches } from '../project-dependencies/runner';
import {
  createWorkspaceSourceBoundaryFromProjects,
  type WorkspaceSourceBoundary,
} from '../typescript-semantic';
import type { AutoScopeProject } from './auto-checker-types';
import { collectCanonicalOwnerProblems } from './canonical-owner-problems';
import type { CheckerOwnershipDiscovery } from './checker-ownership-discovery';
import { collectLockedProjectFacts } from './checker-ownership-locked-facts';
import { createActualMembershipIndex } from './checker-ownership-membership';
import type {
  CheckerDependencyFact,
  TypeConfigOwnershipState,
} from './checker-ownership-types';
import type { FileOwnerLookup } from './file-owner-lookup';
import { collectIndependentCoreWork } from './independent-core-work';
import { freezeSemanticProject } from './locked-semantic-project';

interface FactCollectionOptions {
  preparationFailures?: ReadonlyMap<string, unknown>;
  config: ResolvedLiminaInputs;
  discovery: CheckerOwnershipDiscovery;
  importAnalysis: ImportAnalysisContext;
  membership: FileOwnerLookup;
  projectDependencyCaches: ProjectDependencyCaches;
  projectConfigCache?: CheckerProjectConfigCache;
  workspaceSourceBoundary: WorkspaceSourceBoundary;
}

interface ProjectFacts {
  declarationContexts?: DeclarationContextDecision[];
  failures?: string[];
  facts: CheckerDependencyFact[];
  problems: string[];
}

function collectProjectFacts(options: {
  base: FactCollectionOptions;
  caches: ReturnType<typeof createProjectDependencyCaches>;
  project: AutoScopeProject;
}): ProjectFacts {
  const state = options.base.discovery.plan.typeConfigs.get(
    options.project.configPath,
  )!;
  return collectLockedProjectFacts({
    caches: options.caches,
    discovery: options.base.discovery,
    config: options.base.config,
    importAnalysis: options.base.importAnalysis,
    project: frozenProjectForCollection(options).project,
    state: state as TypeConfigOwnershipState & {
      semanticAuthority: Extract<
        TypeConfigOwnershipState['semanticAuthority'],
        { kind: 'locked' }
      >;
    },
    workspaceSourceBoundary: options.base.workspaceSourceBoundary,
  });
}

function frozenProjectForCollection(
  input: Parameters<typeof collectProjectFacts>[0],
) {
  const configPath = input.project.configPath;
  if (input.base.preparationFailures?.has(configPath))
    throw input.base.preparationFailures.get(configPath);
  const frozen =
    input.base.discovery.frozenProjectsByConfigPath.get(configPath);
  if (frozen === undefined)
    throw new Error(`Missing frozen semantic project for ${configPath}.`);
  return frozen;
}

function prepareFrozenProjects(
  input: Parameters<typeof collectCheckerDependencyFacts>[0],
): Map<string, unknown> {
  const failures = new Map<string, unknown>();
  for (const project of input.discovery.projectByConfigPath.values()) {
    const state = input.discovery.plan.typeConfigs.get(project.configPath)!;
    const authority = state.frozenSemanticAuthority;
    if (
      authority === undefined ||
      state.semanticAuthorityUnavailable !== undefined
    )
      continue;
    try {
      input.discovery.frozenProjectsByConfigPath.set(
        project.configPath,
        freezeSemanticProject({
          project,
          authority,
          projectConfigCache: input.projectConfigCache,
          rootDir: input.config.rootDir,
        }),
      );
    } catch (error) {
      failures.set(project.configPath, error);
    }
  }
  return failures;
}

function collectAllProjectFacts(options: FactCollectionOptions): ProjectFacts {
  const declarationContexts: NonNullable<ProjectFacts['declarationContexts']> =
    [];
  const failures: string[] = [];
  const facts: CheckerDependencyFact[] = [];
  const problems: string[] = [];
  const projects = options.discovery.projectByConfigPath
    .values()
    .toArray()
    .sort((left, right) => compareCodeUnits(left.configPath, right.configPath));
  const caches = options.projectDependencyCaches;
  for (const project of projects) {
    const collected = collectIndependentProjectFacts({
      base: options,
      caches,
      project,
    });
    declarationContexts.push(...(collected.declarationContexts ?? []));
    failures.push(...(collected.failures ?? []));
    facts.push(...collected.facts);
    problems.push(...collected.problems);
  }
  problems.push(
    ...collectCanonicalOwnerProblems({
      facts,
      membership: options.membership,
      rootDir: options.config.rootDir,
    }),
  );
  return { facts, problems, failures, declarationContexts };
}

function collectIndependentProjectFacts(
  input: Parameters<typeof collectProjectFacts>[0],
): ProjectFacts {
  return collectIndependentCoreWork({
    caches: input.caches,
    state: input.base.discovery.plan.typeConfigs.get(input.project.configPath)!,
    membership: input.base.membership,
    collect: () => collectProjectFacts(input),
  });
}

export async function collectCheckerDependencyFacts(options: {
  config: ResolvedLiminaInputs;
  discovery: CheckerOwnershipDiscovery;
  importAnalysis: ImportAnalysisContext;
  projectDependencyCaches?: ProjectDependencyCaches;
  projectConfigCache?: CheckerProjectConfigCache;
}): Promise<string[]> {
  const preparationFailures = prepareFrozenProjects(options);
  const projects = new Map(
    options.discovery.frozenProjectsByConfigPath
      .entries()
      .map(([path, frozen]) => [path, frozen.project]),
  );
  const membership = createActualMembershipIndex(projects);
  const workspaceSourceBoundary = createWorkspaceSourceBoundaryFromProjects(
    projects.values(),
    options.discovery.activatedRegions
      ? {
          membership,
          isWorkspaceFile: (file) =>
            options.discovery.activatedRegions!.findPackageForPath(file) !==
            null,
        }
      : undefined,
    options.discovery.sourceConfigCoverage,
  );
  const caches =
    options.projectDependencyCaches ?? createProjectDependencyCaches();
  caches.sourceConfigCoverage = options.discovery.sourceConfigCoverage;
  caches.supplementalAssessments = [];
  const collected = collectAllProjectFacts({
    ...options,
    preparationFailures,
    membership: workspaceSourceBoundary.governance!.membership,
    projectDependencyCaches: caches,
    workspaceSourceBoundary,
  });
  options.discovery.plan.dependencyFacts = collected.facts;
  options.discovery.plan.dependencyFactPhase = 'locked';
  options.discovery.plan.declarationContexts = collected.declarationContexts;
  return collected.problems;
}
