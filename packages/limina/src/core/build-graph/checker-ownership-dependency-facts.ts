import type { CheckerProjectConfigCache } from '#checkers';
import type { ResolvedLiminaConfig } from '#config/runner';
import { compareCodeUnits } from '#utils/collections';
import type { ImportAnalysisContext } from '../import-analysis/runner';
import type { ProjectDependencyCaches } from '../project-dependencies/contracts';
import { createProjectDependencyCaches } from '../project-dependencies/runner';
import { TypeEvidenceCore } from '../type-evidence';
import {
  createWorkspaceSourceBoundaryFromProjects,
  type WorkspaceSourceBoundary,
} from '../typescript-semantic';
import type { AutoScopeProject } from './auto-checker-types';
import type { CheckerOwnershipDiscovery } from './checker-ownership-discovery';
import { collectLockedProjectFacts } from './checker-ownership-locked-facts';
import { createActualMembershipIndex } from './checker-ownership-membership';
import { collectPendingOwnershipEvidence } from './checker-ownership-pending-facts';
import type {
  CheckerDependencyFact,
  TypeConfigOwnershipState,
} from './checker-ownership-types';

interface FactCollectionOptions {
  config: ResolvedLiminaConfig;
  core: TypeEvidenceCore;
  discovery: CheckerOwnershipDiscovery;
  importAnalysis: ImportAnalysisContext;
  membership: ReadonlyMap<string, string[]>;
  projectDependencyCaches: ProjectDependencyCaches;
  projectConfigCache?: CheckerProjectConfigCache;
  workspaceSourceBoundary: WorkspaceSourceBoundary;
}

interface ProjectFacts {
  facts: CheckerDependencyFact[];
  problems: string[];
}

function getGeneration(cache?: CheckerProjectConfigCache): number {
  return cache?.generation ?? 0;
}

function collectProjectFacts(options: {
  base: FactCollectionOptions;
  caches: ReturnType<typeof createProjectDependencyCaches>;
  project: AutoScopeProject;
}): ProjectFacts {
  const state = options.base.discovery.plan.typeConfigs.get(
    options.project.configPath,
  )!;
  if (state.semanticAuthority.kind === 'pending') {
    return collectPendingOwnershipEvidence({
      ...options.base,
      cache: options.caches.pendingOwnershipEvidenceCache,
      project: options.project,
      state,
    });
  }
  return collectLockedProjectFacts({
    caches: options.caches,
    config: options.base.config,
    importAnalysis: options.base.importAnalysis,
    project: options.project,
    state: state as TypeConfigOwnershipState & {
      semanticAuthority: Extract<
        TypeConfigOwnershipState['semanticAuthority'],
        { kind: 'locked' }
      >;
    },
    workspaceSourceBoundary: options.base.workspaceSourceBoundary,
  });
}

function collectAllProjectFacts(options: FactCollectionOptions): ProjectFacts {
  const facts: CheckerDependencyFact[] = [];
  const problems: string[] = [];
  const projects = [...options.discovery.projectByConfigPath.values()].sort(
    (left, right) => compareCodeUnits(left.configPath, right.configPath),
  );
  const caches = options.projectDependencyCaches;
  for (const project of projects) {
    const collected = collectProjectFacts({ base: options, caches, project });
    facts.push(...collected.facts);
    problems.push(...collected.problems);
  }
  return { facts, problems };
}

export async function collectCheckerDependencyFacts(options: {
  config: ResolvedLiminaConfig;
  discovery: CheckerOwnershipDiscovery;
  importAnalysis: ImportAnalysisContext;
  projectDependencyCaches?: ProjectDependencyCaches;
  projectConfigCache?: CheckerProjectConfigCache;
}): Promise<string[]> {
  const workspaceSourceBoundary = createWorkspaceSourceBoundaryFromProjects(
    options.discovery.projectByConfigPath.values(),
  );
  const core = new TypeEvidenceCore({
    generation: getGeneration(options.projectConfigCache),
    importAnalysis: options.importAnalysis,
    workspaceSourceBoundaryProvider: () => workspaceSourceBoundary,
  });
  try {
    const collected = collectAllProjectFacts({
      ...options,
      core,
      membership: createActualMembershipIndex(
        options.discovery.projectByConfigPath,
      ),
      projectDependencyCaches:
        options.projectDependencyCaches ?? createProjectDependencyCaches(),
      workspaceSourceBoundary,
    });
    options.discovery.plan.dependencyFacts = collected.facts;
    return collected.problems;
  } finally {
    core.dispose();
  }
}
