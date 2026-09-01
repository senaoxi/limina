import type { ResolvedLiminaConfig } from '#config/runner';
import { type AnalysisProviderSet, createAnalysisProviders } from '#core';
import {
  createFileOwnerLookup,
  type ProjectInfo,
} from '#core/import-graph/context';
import type { WorkspacePackage } from '#core/workspace/actions';
import { createProjectDependencyCaches } from '../core/project-dependencies/runner';
import { createWorkspaceSourceBoundaryFromProjects } from '../core/typescript-semantic';
import {
  createWorkspaceExportsResolutionIndex,
  type WorkspaceExportsResolutionProfile,
} from '../core/workspace/exports';
import {
  createWorkspaceLookupIndex,
  type WorkspaceLookupIndex,
} from '../core/workspace/lookup';
import { WorkspaceRegionPathIndex } from '../core/workspace/validated-context';
import type { DependencyGraphCollectionContext } from './collection-types';
import type {
  CollectDependencyGraphOptions,
  DependencyGraphView,
} from './types';

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

function createWorkspaceExportsResolutionProfiles(
  projects: ProjectInfo[],
): WorkspaceExportsResolutionProfile[] {
  return projects.map((project) => ({
    checkerPresets: project.checkerPresets,
    configPath: project.configPath,
    extensions: project.extensions,
    options: project.options,
    resolverConfigPath: project.resolverConfigPath,
  }));
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
}): Promise<WorkspaceLookupIndex> {
  const workspaceContext = await options.core.workspace.getValidatedContext();
  return createWorkspaceLookupIndex({
    importers: [],
    owners: [],
    packages: options.workspacePackages,
    pathIndex: new WorkspaceRegionPathIndex(workspaceContext),
    rootDir: options.config.rootDir,
  });
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

export async function createDependencyGraphCollectionContext(options: {
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
    const workspaceLookup = await createWorkspaceLookup({
      config: options.config,
      core,
      workspacePackages,
    });
    const projects = checkerProjects.projects.map((project) =>
      filterProjectInfoToActivatedRegion(project, workspaceLookup),
    );
    const importAnalysis = core.imports.context;
    const workspaceExports = await createWorkspaceExportsResolutionIndex({
      config: options.config,
      includeOxc: false,
      importAnalysis,
      packages: workspacePackages,
      profiles: createWorkspaceExportsResolutionProfiles(projects),
    });
    problems.push(...workspaceExports.problems);
    throwGraphProblems(problems);

    return {
      config: options.config,
      core,
      edgesByKey: new Map(),
      fileOwnerLookup: createFileOwnerLookup(projects),
      importAnalysis,
      ownsCore,
      problems,
      projectDependencyCaches: createProjectDependencyCaches(),
      projects,
      view: normalizeDependencyGraphView(options.graphOptions.view),
      workspaceExports,
      workspaceLookup,
      workspacePackages,
      workspaceSourceBoundary:
        createWorkspaceSourceBoundaryFromProjects(projects),
    };
  } catch (error) {
    if (ownsCore) core.dispose();
    throw error;
  }
}

export function assertDependencyGraphProblemsEmpty(
  context: DependencyGraphCollectionContext,
): void {
  throwGraphProblems(context.problems);
}
