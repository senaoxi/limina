import type {
  CheckerProjectConfigCache,
  CheckerProjectParseContext,
} from '#checkers';
import type { ResolvedLiminaConfig } from '#config/runner';
import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
import {
  createFileOwnerLookup,
  parseProject,
  type ProjectInfo,
} from '#core/import-graph/context';
import {
  type CollectGraphProjectPathsResult,
  collectGraphProjectRouteFromRoot,
  collectSourceGraphProjectExtensions,
} from '#core/tsconfig/actions';
import { normalizeAbsolutePath } from '#utils/path';
import path from 'pathe';
import type { WorkspaceCore } from './workspace';
import type { WorkspaceLookupIndex } from './workspace/lookup';

export interface SourceGraphProjects {
  problems: string[];
  projects: ProjectInfo[];
}

interface TsconfigCoreOptions {
  config: ResolvedLiminaConfig;
  generatedGraphProvider: () => Promise<GeneratedTsconfigGraphResult>;
  projectConfigCache: CheckerProjectConfigCache;
  workspace?: WorkspaceCore;
}

export class TsconfigCore {
  readonly #config: ResolvedLiminaConfig;
  readonly #generatedGraphProvider: () => Promise<GeneratedTsconfigGraphResult>;
  readonly #projectConfigCache: CheckerProjectConfigCache;
  readonly #workspace: WorkspaceCore | undefined;
  #projectCache = new Map<string, Promise<ProjectInfo>>();
  #referenceGraphCache = new Map<
    string,
    Promise<CollectGraphProjectPathsResult>
  >();
  #sourceGraphProjectsPromise: Promise<SourceGraphProjects> | undefined;

  constructor(options: TsconfigCoreOptions) {
    this.#config = options.config;
    this.#generatedGraphProvider = options.generatedGraphProvider;
    this.#projectConfigCache = options.projectConfigCache;
    this.#workspace = options.workspace;
  }

  async getProject(
    configPath: string,
    contextOrExtensions?: CheckerProjectParseContext | string[],
  ): Promise<ProjectInfo> {
    const cacheKey = createProjectCacheKey(configPath, contextOrExtensions);
    const projectPromise =
      this.#projectCache.get(cacheKey) ??
      this.#generatedGraphProvider().then((generatedGraph) =>
        parseProject(
          this.#config,
          normalizeAbsolutePath(configPath),
          contextOrExtensions,
          generatedGraph.generatedFiles,
          this.#projectConfigCache,
        ),
      );

    this.#projectCache.set(cacheKey, projectPromise);

    return cloneProjectInfo(await projectPromise);
  }

  async getReferenceGraph(
    rootConfigPath: string,
  ): Promise<CollectGraphProjectPathsResult> {
    const normalizedRootConfigPath = normalizeAbsolutePath(rootConfigPath);
    const graphPromise =
      this.#referenceGraphCache.get(normalizedRootConfigPath) ??
      Promise.resolve(
        collectGraphProjectRouteFromRoot({
          rootConfigPath: normalizedRootConfigPath,
          rootDir: this.#config.rootDir,
        }),
      );

    this.#referenceGraphCache.set(normalizedRootConfigPath, graphPromise);

    return cloneReferenceGraph(await graphPromise);
  }

  async getSourceGraphProjects(): Promise<SourceGraphProjects> {
    this.#sourceGraphProjectsPromise ??= this.#generatedGraphProvider().then(
      async (generatedGraph) => {
        const graphRoute = collectSourceGraphProjectExtensions(
          this.#config,
          generatedGraph,
        );
        const projectPaths = [
          ...graphRoute.projectExtensionsByPath.keys(),
        ].sort();
        const workspaceLookup = await this.#getWorkspaceLookupIndex();
        const projects = (
          await Promise.all(
            projectPaths.map((projectPath) =>
              this.getProject(
                projectPath,
                graphRoute.projectContextsByPath.get(projectPath),
              ),
            ),
          )
        ).map((project) =>
          workspaceLookup
            ? filterProjectInfoToActivatedRegion(project, workspaceLookup)
            : project,
        );

        return {
          problems: [...graphRoute.problems],
          projects,
        };
      },
    );

    const result = await this.#sourceGraphProjectsPromise;

    return {
      problems: [...result.problems],
      projects: result.projects.map(cloneProjectInfo),
    };
  }

  async findOwningProject(filePath: string): Promise<ProjectInfo | null> {
    const normalizedFilePath = normalizeAbsolutePath(filePath);
    const { projects } = await this.getSourceGraphProjects();
    const fileOwnerLookup = createFileOwnerLookup(projects);
    const ownerProjectPath = selectOwnerProjectPath(
      fileOwnerLookup.get(normalizedFilePath),
    );

    return findProjectByConfigPath(projects, ownerProjectPath);
  }

  async #getWorkspaceLookupIndex(): Promise<WorkspaceLookupIndex | null> {
    if (!this.#workspace) {
      return null;
    }

    return this.#workspace.getLookupIndex();
  }
}

function compareOwnerProjectPaths(left: string, right: string): number {
  const directoryDepthDelta =
    path.dirname(right).length - path.dirname(left).length;

  return directoryDepthDelta === 0
    ? left.localeCompare(right)
    : directoryDepthDelta;
}

function selectOwnerProjectPath(
  ownerProjectPaths: readonly string[] | undefined,
): string | null {
  if (ownerProjectPaths === undefined) {
    return null;
  }

  const selectedPath = [...ownerProjectPaths].sort(compareOwnerProjectPaths)[0];
  return selectedPath === undefined ? null : selectedPath;
}

function findProjectByConfigPath(
  projects: readonly ProjectInfo[],
  configPath: string | null,
): ProjectInfo | null {
  if (configPath === null) {
    return null;
  }

  const project = projects.find(
    (candidate) => candidate.configPath === configPath,
  );
  return project === undefined ? null : project;
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

function createProjectCacheKey(
  configPath: string,
  contextOrExtensions: CheckerProjectParseContext | string[] | undefined,
): string {
  const context = Array.isArray(contextOrExtensions)
    ? {
        checkerPresets: [],
        extensions: contextOrExtensions,
      }
    : (contextOrExtensions ?? {
        checkerPresets: [],
        extensions: [],
      });

  return JSON.stringify({
    checkerPresets: [...context.checkerPresets].sort(),
    configPath: normalizeAbsolutePath(configPath),
    extensions: [...context.extensions].sort(),
  });
}

export function cloneProjectInfo(project: ProjectInfo): ProjectInfo {
  return {
    ...project,
    checkerPresets: [...project.checkerPresets],
    extensions: [...project.extensions],
    fileNames: [...project.fileNames],
    labels: [...project.labels],
    ownedFileNames: [...project.ownedFileNames],
    references: new Set(project.references),
  };
}

function cloneReferenceGraph(
  graph: CollectGraphProjectPathsResult,
): CollectGraphProjectPathsResult {
  return {
    diagnostics: graph.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      detailLines: [...diagnostic.detailLines],
    })),
    problems: [...graph.problems],
    projectPaths: [...graph.projectPaths],
  };
}
