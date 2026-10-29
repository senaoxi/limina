import type { CheckerProjectConfigCache } from '#checkers';
import type { ResolvedLiminaInputs } from '#config/runner';
import { compareCodeUnits } from '#utils/collections';
import type { DeclarationContextDecision } from '../../domain/analysis/declaration-context';
import type { ImportAnalysisContext } from '../import-analysis/runner';
import type { ProjectDependencyCaches } from '../project-dependencies/contracts';
import { createProjectDependencyCaches } from '../project-dependencies/runner';
import { TypeEvidenceCore } from '../type-evidence';
import {
  createWorkspaceSourceBoundaryFromProjects,
  type WorkspaceSourceBoundary,
} from '../typescript-semantic';
import type { AutoScopeProject } from './auto-checker-types';
import { collectCanonicalOwnerProblems } from './canonical-owner-problems';
import type { CheckerOwnershipDiscovery } from './checker-ownership-discovery';
import { collectLockedProjectFacts } from './checker-ownership-locked-facts';
import { createActualMembershipIndex } from './checker-ownership-membership';
import { collectPendingOwnershipEvidence } from './checker-ownership-pending-facts';
import type {
  CheckerDependencyFact,
  TypeConfigOwnershipState,
} from './checker-ownership-types';
import type { FileOwnerLookup } from './file-owner-lookup';
import { collectIndependentCoreWork } from './independent-core-work';
import { prepareLockedSemanticProject } from './locked-semantic-project';
import { rebindSupplementalAssessments } from './locked-supplemental-assessment';

interface FactCollectionOptions {
  phase?: 'selection' | 'locked';
  config: ResolvedLiminaInputs;
  core: TypeEvidenceCore;
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
      onSupplementalAttempt: () => {
        if (options.caches.analysisCache)
          options.caches.analysisCache.requiresSupplementalReassessment = true;
      },
      baseline: options.caches.nativeSourceContexts?.get(
        options.project.configPath,
      ),
      project: options.project,
      state,
    });
  }
  return collectLockedProjectFacts({
    caches: options.caches,
    config: options.base.config,
    importAnalysis: options.base.importAnalysis,
    project: prepareLockedSemanticProject({
      project: options.project,
      authority: state.semanticAuthority,
      projectConfigCache: options.base.projectConfigCache,
      rootDir: options.base.config.rootDir,
    }),
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
    phase: input.base.phase ?? 'selection',
    membership: input.base.membership,
    collect: () => collectProjectFacts(input),
  });
}

export async function collectCheckerDependencyFacts(options: {
  phase?: 'selection' | 'locked';
  config: ResolvedLiminaInputs;
  discovery: CheckerOwnershipDiscovery;
  importAnalysis: ImportAnalysisContext;
  projectDependencyCaches?: ProjectDependencyCaches;
  projectConfigCache?: CheckerProjectConfigCache;
}): Promise<string[]> {
  const membership = createActualMembershipIndex(
    options.discovery.projectByConfigPath,
  );
  const workspaceSourceBoundary = createWorkspaceSourceBoundaryFromProjects(
    options.discovery.projectByConfigPath.values(),
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
  const core = new TypeEvidenceCore({
    analysisCache: caches.analysisCache,
    generation: getGeneration(options.projectConfigCache),
    importAnalysis: options.importAnalysis,
    workspaceSourceBoundaryProvider: () => workspaceSourceBoundary,
  });
  try {
    const collected = collectAllProjectFacts({
      ...options,
      core,
      membership: workspaceSourceBoundary.governance!.membership,
      projectDependencyCaches: caches,
      workspaceSourceBoundary,
    });
    if (options.phase === 'locked')
      caches.supplementalAssessments = rebindSupplementalAssessments({
        discovery: options.discovery,
        facts: collected.facts,
        importAnalysis: options.importAnalysis,
        rootDir: options.config.rootDir,
        projectConfigCache: options.projectConfigCache,
      });
    retainFactPhase(options, collected.facts);
    if (options.phase === 'locked')
      options.discovery.plan.declarationContexts =
        collected.declarationContexts;
    return collected.problems;
  } finally {
    core.dispose();
  }
}

function retainFactPhase(
  options: Parameters<typeof collectCheckerDependencyFacts>[0],
  facts: CheckerDependencyFact[],
): void {
  const plan = options.discovery.plan;
  if (options.phase === 'locked') {
    plan.ownershipSelectionFacts = structuredClone(plan.dependencyFacts);
  }
  plan.dependencyFacts = facts;
  plan.dependencyFactPhase = options.phase ?? 'selection';
}
