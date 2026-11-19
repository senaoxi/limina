import type { ResolvedLiminaInputs } from '#config/runner';
import { compareCodeUnits } from '#utils/collections';
import type { AnalysisMetricsRecorder } from '../../application/analysis/analysis-run';
import type { NativeAnalysisCache } from '../analysis-cache/native-cache';
import type { ImportAnalysisContext } from '../import-analysis/types';
import { createProjectDependencyCaches } from '../project-dependencies/runner';
import { nativeFingerprint } from '../typescript-semantic/native-file-identity';
import { createWorkspaceSourceBoundaryFromProjects } from '../typescript-semantic/workspace-source-boundary';
import type { CachedGraphData } from './analysis-cache-schema';
import type { CheckerOwnershipDiscovery } from './checker-ownership-discovery';
import { collectLockedProjectFacts } from './checker-ownership-locked-facts';
import { createActualMembershipIndex } from './checker-ownership-membership';
import { projectCoreRelations } from './independent-core-work';

interface Binding {
  graph: CachedGraphData;
  config: ResolvedLiminaInputs;
  discovery: CheckerOwnershipDiscovery;
  cache: NativeAnalysisCache;
  importAnalysis: ImportAnalysisContext;
  metrics?: AnalysisMetricsRecorder;
}

export function hasBoundFrameworkOwnership(input: Binding): boolean {
  const { discovery } = input;
  const frozen = discovery.frozenProjectsByConfigPath;
  const frameworks = [...frozen].filter(
    ([, item]) =>
      item.authority.family === 'astro' || item.authority.family === 'svelte',
  );
  if (frameworks.length === 0) return true;

  const coverage = input.graph.sourceConfigCoverage;
  const regions = discovery.activatedRegions;
  if (coverage === undefined || regions === undefined) return false;
  const projects = new Map(
    [...frozen].map(([file, item]) => [file, item.project]),
  );
  const membership = createActualMembershipIndex(projects);
  const workspaceSourceBoundary = createWorkspaceSourceBoundaryFromProjects(
    projects.values(),
    {
      membership,
      isWorkspaceFile: (file) => regions.findPackageForPath(file) !== null,
    },
    coverage,
  );
  const caches = createProjectDependencyCaches(input.cache, input.metrics);
  caches.sourceConfigCoverage = coverage;
  const stored = input.graph.ownershipPlan;
  const factsByConsumer = Map.groupBy(
    stored.dependencyFacts,
    (fact) => fact.consumerConfigPath,
  );
  const declarationsByConsumer = Map.groupBy(
    stored.declarationContexts ?? [],
    (decision) => decision.consumerConfig,
  );
  const relationsByConsumer = Map.groupBy(
    input.graph.dependencyAnalysis.facts,
    (relation) => relation.fromConfigPath,
  );
  return frameworks.every(([configPath, item]) => {
    const state = discovery.plan.typeConfigs.get(configPath);
    if (state === undefined || state.semanticAuthority.kind !== 'locked')
      return false;
    const facts = collectLockedProjectFacts({
      ...input,
      caches,
      project: item.project,
      state: { ...state, semanticAuthority: state.semanticAuthority },
      workspaceSourceBoundary,
    });
    return (
      facts.problems.length === 0 &&
      facts.failures.length === 0 &&
      hasSameRecords(facts.facts, factsByConsumer.get(configPath)) &&
      hasSameRecords(
        [...projectCoreRelations(facts.facts, membership)],
        relationsByConsumer.get(configPath),
      ) &&
      hasSameRecords(
        facts.declarationContexts,
        declarationsByConsumer.get(configPath),
      )
    );
  });
}

function hasSameRecords(
  current: readonly unknown[],
  stored: readonly unknown[] | undefined,
): boolean {
  const keys = (values: readonly unknown[]) =>
    values.map(nativeFingerprint).sort(compareCodeUnits);
  return (
    nativeFingerprint(keys(current)) === nativeFingerprint(keys(stored ?? []))
  );
}
