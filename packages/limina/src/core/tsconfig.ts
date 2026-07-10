import type { CheckerProjectParseContext } from '#checkers';
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
import {
  createWorkspaceLookupIndex,
  type WorkspaceLookupIndex,
} from './workspace/lookup';

export interface SourceGraphProjects {
  problems: string[];
  projects: ProjectInfo[];
}

export class TsconfigCore {
  readonly #config: ResolvedLiminaConfig;
  readonly #generatedGraphProvider: () => Promise<GeneratedTsconfigGraphResult>;
  readonly #workspace: WorkspaceCore | undefined;
  #projectCache = new Map<string, Promise<ProjectInfo>>();
  #referenceGraphCache = new Map<
    string,
    Promise<CollectGraphProjectPathsResult>
  >();
  #sourceGraphProjectsPromise: Promise<SourceGraphProjects> | undefined;

  constructor(
    config: ResolvedLiminaConfig,
    generatedGraphProvider: () => Promise<GeneratedTsconfigGraphResult>,
    workspace?: WorkspaceCore,
  ) {
    this.#config = config;
    this.#generatedGraphProvider = generatedGraphProvider;
    this.#workspace = workspace;
  }

  invalidate(): void {
    this.#projectCache.clear();
    this.#referenceGraphCache.clear();
    this.#sourceGraphProjectsPromise = undefined;
  }

  async getProject(
    configPath: string,
    contextOrExtensions?: CheckerProjectParseContext | string[],
  ): Promise<ProjectInfo> {
    const cacheKey = createProjectCacheKey(configPath, contextOrExtensions);
    const projectPromise =
      this.#projectCache.get(cacheKey) ??
      Promise.resolve(
        parseProject(
          this.#config,
          normalizeAbsolutePath(configPath),
          contextOrExtensions,
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
        const workspaceLookup = await this.#createWorkspaceLookupIndex();
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
    const ownerProjectPaths = fileOwnerLookup.get(normalizedFilePath);

    if (!ownerProjectPaths || ownerProjectPaths.length === 0) {
      return null;
    }

    const [projectPath] = [...ownerProjectPaths].sort((left, right) => {
      const directoryDepthDelta =
        path.dirname(right).length - path.dirname(left).length;

      return directoryDepthDelta === 0
        ? left.localeCompare(right)
        : directoryDepthDelta;
    });

    return (
      (projectPath
        ? projects.find((project) => project.configPath === projectPath)
        : null) ?? null
    );
  }

  async #createWorkspaceLookupIndex(): Promise<WorkspaceLookupIndex | null> {
    if (!this.#workspace) {
      return null;
    }

    const [importers, owners, packages, regionBoundaries] = await Promise.all([
      this.#workspace.getImporters(),
      this.#workspace.getPackageOwners(),
      this.#workspace.getPackages(),
      this.#workspace.getRegionBoundaries(),
    ]);

    return createWorkspaceLookupIndex({
      importers,
      owners,
      packages,
      regionBoundaries,
      rootDir: this.#config.rootDir,
    });
  }
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
    problems: [...graph.problems],
    projectPaths: [...graph.projectPaths],
  };
}
