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
import { collectCanonicalOwnerProblems } from './canonical-owner-problems';
import type { CheckerOwnershipDiscovery } from './checker-ownership-discovery';
import { collectLockedProjectFacts } from './checker-ownership-locked-facts';
import { createActualMembershipIndex } from './checker-ownership-membership';
import type {
  CheckerDependencyFact,
  TypeConfigOwnershipState,
} from './checker-ownership-types';
import { coreCollectionRun } from './core-collection-run';
import { createDeclarationContextPolicy } from './declaration-context-policy';
import type { FileOwnerLookup } from './file-owner-lookup';
import { collectIndependentCoreWork } from './independent-core-work';

interface FactCollectionOptions {
  config: ResolvedLiminaInputs;
  discovery: CheckerOwnershipDiscovery;
  importAnalysis: ImportAnalysisContext;
  membership: FileOwnerLookup;
  projectDependencyCaches: ProjectDependencyCaches;
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
  configPath: string;
}): ProjectFacts {
  const state = options.base.discovery.plan.typeConfigs.get(
    options.configPath,
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
  const configPath = input.configPath;
  if (input.base.discovery.preparationFailures?.has(configPath))
    throw input.base.discovery.preparationFailures.get(configPath);
  const frozen =
    input.base.discovery.frozenProjectsByConfigPath.get(configPath);
  if (frozen === undefined)
    throw new Error(`Missing frozen semantic project for ${configPath}.`);
  return frozen;
}

function collectAllProjectFacts(options: FactCollectionOptions): ProjectFacts {
  const declarationContexts: NonNullable<ProjectFacts['declarationContexts']> =
    [];
  const failures: string[] = [];
  const facts: CheckerDependencyFact[] = [];
  const problems: string[] = [];
  const configs = options.discovery.plan.typeConfigs
    .keys()
    .toArray()
    .sort(compareCodeUnits);
  const caches = options.projectDependencyCaches;
  for (const configPath of configs) {
    const collected = collectIndependentProjectFacts({
      base: options,
      caches,
      configPath,
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
    state: input.base.discovery.plan.typeConfigs.get(input.configPath)!,
    membership: input.base.membership,
    collect: () => collectProjectFacts(input),
  });
}

export function collectCheckerDependencyFacts(options: {
  config: ResolvedLiminaInputs;
  discovery: CheckerOwnershipDiscovery;
  importAnalysis: ImportAnalysisContext;
  projectDependencyCaches?: ProjectDependencyCaches;
}): string[] {
  const projects = options.discovery.projectByConfigPath;
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
  caches.lockedWorkspaceSourceBoundary = workspaceSourceBoundary;
  caches.sourceConfigCoverage = options.discovery.sourceConfigCoverage;
  const regions = options.discovery.activatedRegions;
  if (regions && caches.sourceConfigCoverage)
    caches.declarationContextPolicy = createDeclarationContextPolicy({
      config: options.config,
      coverage: caches.sourceConfigCoverage,
      units: options.discovery.plan.typeConfigs.keys(),
      inRegion: (path) => regions.isInsideActivatedRegion(path),
    });
  caches.supplementalAssessments = [];
  const collected = collectAllProjectFacts({
    ...options,
    membership: workspaceSourceBoundary.governance!.membership,
    projectDependencyCaches: caches,
    workspaceSourceBoundary,
  });
  options.discovery.plan.dependencyFacts = collected.facts;
  options.discovery.plan.dependencyFactPhase = 'locked';
  options.discovery.plan.declarationContexts = collected.declarationContexts;
  coreCollectionRun(caches).declarationContexts = collected.declarationContexts;
  return collected.problems;
}
