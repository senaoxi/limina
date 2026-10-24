import type { ResolvedLiminaConfig } from '#config/runner';
import { type AnalysisProviderSet, createAnalysisProviders } from '#core';
import {
  createFileOwnerLookup,
  type ImportAnalysisContext,
  type ProjectInfo,
} from '#core/import-graph/context';
import type { WorkspacePackage } from '#core/workspace/actions';
import { FileOwnerLookup } from '../core/build-graph/file-owner-lookup';
import type { ProjectDependencyCaches } from '../core/project-dependencies/contracts';
import { createProjectDependencyCaches } from '../core/project-dependencies/runner';
import {
  createWorkspaceSourceBoundaryFromProjects,
  type WorkspaceSourceBoundary,
} from '../core/typescript-semantic';
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
  core: AnalysisProviderSet;
  edgesByKey: Map<string, DependencyGraphEdge>;
  fileOwnerLookup: Map<string, string[]>;
  importAnalysis: ImportAnalysisContext;
  ownsCore: boolean;
  outputRoots: readonly string[];
  pathIndex: WorkspaceRegionPathIndex;
  problems: string[];
  projectDependencyCaches: ProjectDependencyCaches;
  projects: ProjectInfo[];
  view: DependencyGraphView;
  workspaceLookup: WorkspaceLookupIndex;
  workspacePackages: WorkspacePackage[];
  workspaceSourceBoundary: WorkspaceSourceBoundary;
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
    core: createAnalysisProviders(options.config),
    ownsCore: true,
  };
}

async function createDependencyGraphCollectionContext(options: {
  config: ResolvedLiminaConfig;
  graphOptions: CollectDependencyGraphOptions;
}): Promise<DependencyGraphCollectionContext> {
  const { core, ownsCore } = resolveCollectionCore({
    config: options.config,
    providers: options.graphOptions.providers,
  });
  try {
    const checkerProjects = await core.tsconfig.getSourceGraphProjects();
    const problems = [...checkerProjects.problems];
    const workspacePackages = await core.workspace.getPackages();
    const { workspaceLookup, outputRoots, pathIndex } =
      await createWorkspaceLookup({
        config: options.config,
        core,
        workspacePackages,
      });
    const projects = checkerProjects.projects.map((project) =>
      filterProjectInfoToActivatedRegion(project, workspaceLookup),
    );
    const importAnalysis = core.imports.context;
    const membership = createFileOwnerLookup(projects);
    throwGraphProblems(problems);

    return {
      config: options.config,
      core,
      edgesByKey: new Map(),
      fileOwnerLookup: membership,
      importAnalysis,
      ownsCore,
      outputRoots,
      pathIndex,
      problems,
      projectDependencyCaches: createProjectDependencyCaches(),
      projects,
      view: normalizeDependencyGraphView(options.graphOptions.view),
      workspaceLookup,
      workspacePackages,
      workspaceSourceBoundary: createWorkspaceSourceBoundaryFromProjects(
        projects,
        {
          membership: new FileOwnerLookup(projects),
          isWorkspaceFile: (file) =>
            pathIndex.findPackageForPath(file) !== null,
        },
      ),
    };
  } catch (error) {
    if (ownsCore) core.dispose();
    throw error;
  }
}

function assertDependencyGraphProblemsEmpty(
  context: DependencyGraphCollectionContext,
): void {
  throwGraphProblems(context.problems);
}

export async function collectDependencyGraph(
  config: ResolvedLiminaConfig,
  options: CollectDependencyGraphOptions = {},
): Promise<DependencyGraphDocument> {
  const context = await createDependencyGraphCollectionContext({
    config,
    graphOptions: options,
  });
  try {
    collectDependencyGraphEdges(context);
    assertDependencyGraphProblemsEmpty(context);
    return {
      edges: sortEdges(context.edgesByKey.values().toArray()),
      nodes: createNodes(config, context.workspacePackages),
      rootDir: '.',
      schemaVersion: 1,
      view: context.view,
    };
  } finally {
    if (context.ownsCore) context.core.dispose();
  }
}

export function stringifyDependencyGraph(
  graph: DependencyGraphDocument,
): string {
  return `${JSON.stringify(graph, null, 2)}\n`;
}

export type * from './model';
