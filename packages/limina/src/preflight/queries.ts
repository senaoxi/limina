import type { ResolvedLiminaConfig } from '#config/runner';
import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
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
import type { ValidatedWorkspaceContext } from '../core/workspace/validated-context';
import { collectExpectedSourceFiles } from '../proof/source-files';

export async function loadCheckerRouteSnapshot(
  config: ResolvedLiminaConfig,
  graph: Promise<GeneratedTsconfigGraphResult>,
  getMetrics: () => AnalysisMetricsRecorder,
): Promise<CheckerRouteSnapshotCollection> {
  const result = await graph;
  return collectCheckerRouteSnapshot(config, result, getMetrics());
}

export async function loadGeneratedGraph(
  validated: Promise<ValidatedWorkspaceContext>,
  getGraph: () => Promise<GeneratedTsconfigGraphResult>,
): Promise<GeneratedTsconfigGraphResult> {
  await validated;
  return getGraph();
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
  prerequisite: Promise<
    [GeneratedTsconfigGraphResult, ValidatedWorkspaceContext]
  >,
): Promise<Set<string>> {
  const [graph, context] = await prerequisite;
  return collectExpectedSourceFiles(config, graph, context);
}
