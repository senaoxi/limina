import type { ResolvedLiminaConfig } from '#config/runner';
import {
  type AnalysisProviderSet,
  createAnalysisProviders,
  planCapabilitySubscriptions,
} from '#core';
import {
  createFileOwnerLookup,
  type ProjectInfo,
} from '#core/import-graph/context';
import type { WorkspacePackage } from '#core/workspace/actions';
import {
  type PreparedDependencyGraphProject,
  prepareDependencyGraphProjects,
} from '../core/facts/graph-projects';
import {
  createWorkspaceLookupIndex,
  type WorkspaceLookupIndex,
} from '../core/workspace/lookup';
import { WorkspaceRegionPathIndex } from '../core/workspace/validated-context';
import { collectDependencyGraphEdges } from './edges';
import {
  type CollectDependencyGraphOptions,
  createNodes,
  type DependencyGraphDocument,
  type DependencyGraphEdge,
  type DependencyGraphView,
  sortEdges,
} from './model';

export interface DependencyGraphCollectionContext {
  config: ResolvedLiminaConfig;
  edgesByKey: Map<string, DependencyGraphEdge>;
  fileOwnerLookup: Map<string, string[]>;
  outputRoots: readonly string[];
  pathIndex: WorkspaceRegionPathIndex;
  problems: string[];
  projectDependencies: readonly PreparedDependencyGraphProject[];
  view: DependencyGraphView;
  workspaceLookup: WorkspaceLookupIndex;
  workspacePackages: WorkspacePackage[];
}

function filterProjectInfoToActivatedRegion(
  project: ProjectInfo,
  workspaceLookup: WorkspaceLookupIndex,
): ProjectInfo {
  return {
    ...project,
    fileNames: project.fileNames.filter((fileName) =>
      workspaceLookup.isInsideActivatedRegion(fileName),
    ),
    ownedFileNames: project.ownedFileNames.filter((fileName) =>
      workspaceLookup.isInsideActivatedRegion(fileName),
    ),
  };
}

function normalizeDependencyGraphView(
  view: DependencyGraphView | undefined,
): DependencyGraphView {
  return view ?? 'all';
}

function throwGraphProblems(problems: readonly string[]): void {
  if (problems.length > 0) {
    throw new Error(problems.join('\n\n'));
  }
}

async function createWorkspaceLookup(options: {
  config: ResolvedLiminaConfig;
  core: AnalysisProviderSet;
  workspacePackages: WorkspacePackage[];
}): Promise<{
  workspaceLookup: WorkspaceLookupIndex;
  pathIndex: WorkspaceRegionPathIndex;
  outputRoots: readonly string[];
}> {
  const workspaceContext = await options.core.workspace.getValidatedContext();
  const pathIndex = new WorkspaceRegionPathIndex(workspaceContext);
  const workspaceLookup = createWorkspaceLookupIndex({
    importers: [],
    owners: [],
    packages: options.workspacePackages,
    pathIndex,
    rootDir: options.config.rootDir,
  });
  return {
    workspaceLookup,
    pathIndex,
    outputRoots: workspaceContext.outputRoots.map(
      (root) => pathIndex.classifyPath(root).canonicalPath,
    ),
  };
}

function resolveCollectionCore(options: {
  config: ResolvedLiminaConfig;
  providers: AnalysisProviderSet | undefined;
}): { core: AnalysisProviderSet; ownsCore: boolean } {
  if (options.providers !== undefined) {
    return { core: options.providers, ownsCore: false };
  }
  return {
    core: createAnalysisProviders(options.config, undefined, undefined, {
      subscriptionPlan: planCapabilitySubscriptions(['dependency-graph']),
    }),
    ownsCore: true,
  };
}

async function createDependencyGraphCollectionContext(options: {
  config: ResolvedLiminaConfig;
  core: AnalysisProviderSet;
  view: DependencyGraphView;
}): Promise<DependencyGraphCollectionContext> {
  const { config, core, view } = options;
  const checkerProjects = await core.tsconfig.getSourceGraphProjects();
  const workspacePackages = await core.workspace.getPackages();
  const { workspaceLookup, outputRoots, pathIndex } =
    await createWorkspaceLookup({
      config,
      core,
      workspacePackages,
    });
  const projects = checkerProjects.projects.map((project) =>
    filterProjectInfoToActivatedRegion(project, workspaceLookup),
  );
  throwGraphProblems(checkerProjects.problems);

  return {
    config,
    edgesByKey: new Map(),
    fileOwnerLookup: createFileOwnerLookup(projects),
    outputRoots,
    pathIndex,
    problems: [],
    projectDependencies: await prepareDependencyGraphProjects({
      generatedGraph: await core.buildGraph.getGraph(),
      pathIndex,
      projects,
      providers: core,
      rootDir: config.rootDir,
      workspaceLookup,
    }),
    view,
    workspaceLookup,
    workspacePackages,
  };
}

export async function collectDependencyGraph(
  config: ResolvedLiminaConfig,
  options: CollectDependencyGraphOptions = {},
): Promise<DependencyGraphDocument> {
  const { core, ownsCore } = resolveCollectionCore({
    config,
    providers: options.providers,
  });
  try {
    const context = await createDependencyGraphCollectionContext({
      config,
      core,
      view: normalizeDependencyGraphView(options.view),
    });
    collectDependencyGraphEdges(context);
    throwGraphProblems(context.problems);
    return {
      edges: sortEdges(context.edgesByKey.values().toArray()),
      nodes: createNodes(config, context.workspacePackages),
      rootDir: '.',
      schemaVersion: 1,
      view: context.view,
    };
  } finally {
    if (ownsCore) core.dispose();
  }
}

export function stringifyDependencyGraph(
  graph: DependencyGraphDocument,
): string {
  return `${JSON.stringify(graph, null, 2)}\n`;
}

export type * from './model';
