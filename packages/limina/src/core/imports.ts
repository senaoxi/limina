import type { ResolvedLiminaConfig } from '#config/runner';
import {
  createImportAnalysisContext,
  type ImportAnalysisContext,
  type ImportAnalysisMetricsRecorder,
  type ImportRecord,
} from '#core/import-analysis/runner';
import type { ProjectInfo } from '#core/import-graph/context';
import { normalizeAbsolutePath } from '#utils/path';
import path from 'pathe';
import type { AstroSemanticContextManager } from './astro-semantic/context';
import {
  collectProjectDependencies,
  createParsedProjectSemanticContext,
  createProjectDependencyCaches,
  type ProjectDependencyCollection,
} from './project-dependencies/runner';
import type { SvelteSemanticContextManager } from './svelte-semantic/context';
import type { VueSemanticContextManager } from './vue-semantic/context';

export interface ResolveImportOptions {
  containingFile: string;
  project: ProjectInfo;
  specifier: string;
}

export interface ResolvedImportRecord {
  importRecord: ImportRecord;
  resolvedFilePath: string | null;
}

interface ImportCoreOptions {
  astroSemanticContexts?: AstroSemanticContextManager;
  metrics?: ImportAnalysisMetricsRecorder;
  svelteSemanticContexts?: SvelteSemanticContextManager;
  vueSemanticContexts?: VueSemanticContextManager;
}

function getProjectSemanticAuthority(project: ProjectInfo) {
  if (project.semanticAuthority !== undefined) return project.semanticAuthority;
  throw new Error(
    `Project-aware import resolution requires frozen semantic authority: ${project.configPath}`,
  );
}

function isDefined(value: string | undefined): value is string {
  return value !== undefined;
}

function getAstroPackageRoot(project: ProjectInfo): string | undefined {
  const semanticProject = project.astroSemanticProject;
  return semanticProject === undefined
    ? undefined
    : semanticProject.seed.packageRootDir;
}

function getSveltePackageRoot(project: ProjectInfo): string | undefined {
  return project.svelteSemanticProject?.packageRootDir;
}

function getVuePackageRoot(project: ProjectInfo): string | undefined {
  return project.vueSemanticIdentity?.projectRootDir;
}

function getProjectPackageRoot(project: ProjectInfo): string {
  return (
    [
      getAstroPackageRoot(project),
      getSveltePackageRoot(project),
      getVuePackageRoot(project),
    ].find(isDefined) ?? path.dirname(project.configPath)
  );
}

function assertProjectDependencyCollection(
  collection: ProjectDependencyCollection,
): ProjectDependencyCollection {
  if (collection.failures.length === 0) return collection;
  throw new Error(
    collection.failures
      .map(
        (failure) =>
          `Project dependency collection failed (${failure.framework}/${failure.stage}): ${failure.reason}`,
      )
      .join('\n\n'),
  );
}

export class ImportCore {
  readonly #config: ResolvedLiminaConfig;
  #context: ImportAnalysisContext;
  readonly #projectDependencyCaches = createProjectDependencyCaches();

  constructor(config: ResolvedLiminaConfig, options: ImportCoreOptions = {}) {
    this.#config = config;
    this.#context = this.#createContext(options);
  }

  get context(): ImportAnalysisContext {
    return this.#context;
  }

  #createContext(options: ImportCoreOptions): ImportAnalysisContext {
    return createImportAnalysisContext({
      astroSemanticContexts: options.astroSemanticContexts,
      metrics: options.metrics,
      projectRootDir: this.#config.rootDir,
      svelteSemanticContexts: options.svelteSemanticContexts,
      vueSemanticContexts: options.vueSemanticContexts,
    });
  }

  getImports(filePath: string): ImportRecord[] {
    return this.#context
      .collectImportsFromFile(
        normalizeAbsolutePath(filePath),
        this.#config.rootDir,
      )
      .map((record) => ({ ...record }));
  }

  resolveImport(options: ResolveImportOptions): string | null {
    const containingFile = normalizeAbsolutePath(options.containingFile);
    const dependency = this.#collectProject(options.project).dependencies.find(
      (candidate) =>
        candidate.importRecord.filePath === containingFile &&
        candidate.importRecord.specifier === options.specifier,
    );
    return dependency?.resolvedFilePath ?? null;
  }

  getResolvedImports(
    filePath: string,
    project: ProjectInfo,
  ): ResolvedImportRecord[] {
    const normalizedFilePath = normalizeAbsolutePath(filePath);
    const collection = this.#collectProject(project);
    return [
      ...collection.dependencies
        .filter(
          (dependency) =>
            dependency.importRecord.filePath === normalizedFilePath,
        )
        .map((dependency) => ({
          importRecord: dependency.importRecord,
          resolvedFilePath: dependency.resolvedFilePath,
        })),
      ...collection.observations.flatMap((observation) =>
        observation.kind === 'unmapped-generated' ||
        observation.importRecord.filePath !== normalizedFilePath
          ? []
          : [
              {
                importRecord: observation.importRecord,
                resolvedFilePath: null,
              },
            ],
      ),
    ].sort(
      (left, right) =>
        left.importRecord.locator.sourceStart -
        right.importRecord.locator.sourceStart,
    );
  }

  #collectProject(project: ProjectInfo): ProjectDependencyCollection {
    const authority = getProjectSemanticAuthority(project);
    const packageRootDir = getProjectPackageRoot(project);
    const collection = collectProjectDependencies({
      caches: this.#projectDependencyCaches,
      context: createParsedProjectSemanticContext({
        authority,
        packageRootDir,
        project,
      }),
      importAnalysis: this.#context,
    });
    return assertProjectDependencyCollection(collection);
  }
}
