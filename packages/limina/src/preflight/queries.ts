import type { ResolvedLiminaConfig } from '#config/runner';
import type {
  GeneratedTsconfigGraphResult,
  PreparedTsconfigGraph,
} from '#core/build-graph/runner';
import {
  type CheckerRouteSnapshotCollection,
  type CollectCheckerGraphProjectRoutesResult,
  collectCheckerRouteSnapshot,
  type CollectSourceGraphProjectExtensionsResult,
  projectCheckerEntryProjectRoutes,
  projectGraphProjectRoutes,
  projectSourceGraphProjectExtensions,
} from '#core/tsconfig/actions';
import type { WorkspacePackage } from '#core/workspace/actions';
import type { AnalysisMetricsRecorder } from '../application/analysis/analysis-run';
import {
  type AnalysisObserver,
  currentProfile,
} from '../application/analysis/observability';
import { graphPreparationWork } from '../core/build-graph/graph-profile';
import { collectExpectedSourceFiles } from '../core/workspace/expected-source-files';
import type { ValidatedWorkspaceContext } from '../core/workspace/validated-context';
import type { AnalysisCacheController } from './analysis-cache';
import type { ConfigObservation } from './config-observation';
import type { LiminaPreflightManager } from './manager';
import {
  createPackageEntrySelectionPlan,
  type PackageEntrySelectionPlan,
} from './package-entry-selection';
import type { PackageEntryPlanOptions } from './types';

export async function loadCheckerRouteSnapshot(
  config: ResolvedLiminaConfig,
  graph: Promise<GeneratedTsconfigGraphResult>,
  getMetrics: () => AnalysisMetricsRecorder,
): Promise<CheckerRouteSnapshotCollection> {
  const result = await graph;
  return collectCheckerRouteSnapshot(config, result, getMetrics());
}

export async function loadWorkspacePackages(
  validated: Promise<ValidatedWorkspaceContext>,
): Promise<WorkspacePackage[]> {
  const context = await validated;
  return context.packages.map((workspacePackage) => ({
    ...workspacePackage,
    manifest: { ...workspacePackage.manifest },
  }));
}

export async function loadSourceGraphProjectExtensions(
  config: ResolvedLiminaConfig,
  prerequisite: Promise<
    [CheckerRouteSnapshotCollection, GeneratedTsconfigGraphResult]
  >,
): Promise<CollectSourceGraphProjectExtensionsResult> {
  const [snapshot, graph] = await prerequisite;
  return projectSourceGraphProjectExtensions(config, snapshot, graph);
}

export async function loadGraphProjectRoutes(
  config: ResolvedLiminaConfig,
  prerequisite: Promise<CheckerRouteSnapshotCollection>,
): Promise<CollectCheckerGraphProjectRoutesResult> {
  return projectGraphProjectRoutes(config, await prerequisite);
}

export async function loadCheckerEntryProjectRoutes(
  config: ResolvedLiminaConfig,
  prerequisite: Promise<CheckerRouteSnapshotCollection>,
): Promise<CollectCheckerGraphProjectRoutesResult> {
  return projectCheckerEntryProjectRoutes(config, await prerequisite);
}

export async function loadExpectedSourceFiles(
  config: ResolvedLiminaConfig,
  workspaceContext: Promise<ValidatedWorkspaceContext>,
): Promise<Set<string>> {
  return collectExpectedSourceFiles(config, undefined, await workspaceContext);
}

export async function loadPackageEntrySelectionPlan(
  source: Pick<LiminaPreflightManager, 'config' | 'ensureWorkspaceValidated'>,
  options: PackageEntryPlanOptions,
): Promise<PackageEntrySelectionPlan> {
  const context = await source.ensureWorkspaceValidated();
  return createPackageEntrySelectionPlan({
    config: source.config,
    cwd: options.cwd,
    packageNames: options.packageNames,
    requireCwdPackageMatch: options.requireCwdPackageMatch,
    tool: options.tool,
    workspaceContext: context,
  });
}

async function analyzeWithoutCache<T>(
  observation: Pick<ConfigObservation, 'assertStable'> | undefined,
  analyze: () => Promise<T>,
): Promise<T> {
  observation?.assertStable();
  const result = await analyze();
  observation?.assertStable();
  return result;
}

export function loadAnalyzedGraph<T extends PreparedTsconfigGraph>(options: {
  cache: AnalysisCacheController | undefined;
  configObservation?: Pick<ConfigObservation, 'assertStable'>;
  source: Pick<LiminaPreflightManager, 'ensureWorkspaceValidated'>;
  getGraph: () => Promise<T>;
  providerRun: (profile: AnalysisObserver) => string;
  refresh(): void;
}): Promise<T> {
  const profile = currentProfile();
  let previousAttempt: string | undefined;
  let attempt = 0;
  const analyze = async () => {
    if (profile === undefined) {
      await options.source.ensureWorkspaceValidated();
      return options.getGraph();
    }
    const number = ++attempt;
    const work = profile.start('graph.attempt', undefined, undefined, number);
    if (previousAttempt !== undefined) {
      profile.finish(previousAttempt, 'superseded', 'analysis-input-drift');
      profile.link('retry-of', work, previousAttempt);
    }
    previousAttempt = work;
    return profile.inWork(work, async () => {
      await options.source.ensureWorkspaceValidated();
      const providerRun = options.providerRun(profile);
      const graph = await profile.withProviderRun(
        providerRun,
        options.getGraph,
      );
      const producer = graphPreparationWork(profile, graph);
      if (producer !== undefined) profile.link('uses-result', work, producer);
      profile.graph(profile.identity(graph, 'graph'), {
        attempt: number,
        providerRun,
      });
      return graph;
    });
  };
  const result =
    options.cache === undefined
      ? analyzeWithoutCache(options.configObservation, analyze)
      : options.cache.analyze({ analyze, refresh: options.refresh });
  if (profile === undefined) return result;
  (async () => {
    try {
      await result;
      if (previousAttempt !== undefined) profile.finish(previousAttempt);
    } catch (error) {
      if (previousAttempt !== undefined)
        profile.fail(previousAttempt, error, 'graph-attempt-failed');
    }
  })();
  return result;
}
