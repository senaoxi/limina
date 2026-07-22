import type { CheckerProjectParseContext } from '#checkers';
import type { ResolvedLiminaConfig } from '#config/runner';
import {
  createImportAnalysisContext,
  type ImportAnalysisContext,
  type ImportAnalysisMetricsRecorder,
  type ImportRecord,
} from '#core/import-analysis/runner';
import type { ProjectInfo } from '#core/import-graph/context';
import { normalizeAbsolutePath } from '#utils/path';

export interface ResolveImportOptions {
  containingFile: string;
  project: ProjectInfo;
  specifier: string;
}

export interface ResolvedImportRecord {
  importRecord: ImportRecord;
  resolvedFilePath: string | null;
}

export class ImportCore {
  readonly #config: ResolvedLiminaConfig;
  #context: ImportAnalysisContext;

  constructor(
    config: ResolvedLiminaConfig,
    metrics?: ImportAnalysisMetricsRecorder,
  ) {
    this.#config = config;
    this.#context = this.#createContext(metrics);
  }

  get context(): ImportAnalysisContext {
    return this.#context;
  }

  #createContext(
    metrics?: ImportAnalysisMetricsRecorder,
  ): ImportAnalysisContext {
    return createImportAnalysisContext({
      metrics,
      projectRootDir: this.#config.rootDir,
      vueParser: this.#config.config?.imports?.vue,
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
    return this.#context.resolveInternalImport(
      options.specifier,
      options.containingFile,
      options.project.options,
      createProjectResolveContext(options.project),
    );
  }

  getResolvedImports(
    filePath: string,
    project: ProjectInfo,
  ): ResolvedImportRecord[] {
    return this.getImports(filePath).map((importRecord) => ({
      importRecord,
      resolvedFilePath: this.resolveImport({
        containingFile: importRecord.filePath,
        project,
        specifier: importRecord.specifier,
      }),
    }));
  }
}

function createProjectResolveContext(
  project: ProjectInfo,
): CheckerProjectParseContext & {
  configPath: string;
  resolverConfigPath: string;
} {
  return {
    checkerPresets: project.checkerPresets,
    configPath: project.configPath,
    extensions: project.extensions,
    resolverConfigPath: project.resolverConfigPath,
  };
}
