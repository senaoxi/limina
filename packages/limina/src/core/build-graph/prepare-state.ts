import type { ResolvedCheckerConfig } from '#config/runner';
import type {
  CheckerSourceConfigCollection,
  GeneratedBuildModule,
  GeneratedGraphWriteContext,
  GeneratedOutputDeclarationCopyContext,
  GeneratedProviderEdge,
  OutputSolutionProject,
  PreparedCheckerGraph,
  SolutionProject,
  SourceProject,
} from './types';

export interface GeneratedGraphPreparationState {
  checkerCollectionsByName: Map<string, CheckerSourceConfigCollection>;
  checkerEntries: Map<string, string>;
  configToOutputBuildByChecker: Map<string, Map<string, GeneratedBuildModule>>;
  outputDeclarationCopiesByChecker: Map<
    string,
    Map<string, GeneratedOutputDeclarationCopyContext[]>
  >;
  outputProjectsByChecker: Map<string, SourceProject[]>;
  outputSolutionsByChecker: Map<string, OutputSolutionProject[]>;
  problems: string[];
  projectsByChecker: Map<string, SourceProject[]>;
  providerEdges: GeneratedProviderEdge[];
  rootBuildPathsByChecker: Map<string, string[]>;
  solutionsByChecker: Map<string, SolutionProject[]>;
  sourceToBuildByChecker: Map<string, Map<string, GeneratedBuildModule>>;
  writeContext: GeneratedGraphWriteContext;
}

export function createGeneratedGraphPreparationState(
  rootDir: string,
): GeneratedGraphPreparationState {
  return {
    checkerCollectionsByName: new Map(),
    checkerEntries: new Map(),
    configToOutputBuildByChecker: new Map(),
    outputDeclarationCopiesByChecker: new Map(),
    outputProjectsByChecker: new Map(),
    outputSolutionsByChecker: new Map(),
    problems: [],
    projectsByChecker: new Map(),
    providerEdges: [],
    rootBuildPathsByChecker: new Map(),
    solutionsByChecker: new Map(),
    sourceToBuildByChecker: new Map(),
    writeContext: {
      changes: [],
      changed: false,
      expectedFiles: new Set(),
      files: new Map(),
      rootDir,
    },
  };
}

export function registerPreparedChecker(options: {
  preparedChecker: PreparedCheckerGraph;
  state: GeneratedGraphPreparationState;
}): void {
  const checkerName = options.preparedChecker.checker.name;
  options.state.checkerCollectionsByName.set(
    checkerName,
    options.preparedChecker.collection,
  );
  options.state.projectsByChecker.set(
    checkerName,
    options.preparedChecker.projects,
  );
  options.state.solutionsByChecker.set(
    checkerName,
    options.preparedChecker.solutions,
  );
  options.state.sourceToBuildByChecker.set(
    checkerName,
    options.preparedChecker.collection.buildModulesBySourcePath,
  );
  options.state.rootBuildPathsByChecker.set(
    checkerName,
    options.preparedChecker.rootBuildPaths,
  );
  options.state.checkerEntries.set(
    checkerName,
    options.preparedChecker.entryPath,
  );
}

export function getCheckerProjects(options: {
  checker: ResolvedCheckerConfig;
  state: GeneratedGraphPreparationState;
}): SourceProject[] {
  return options.state.projectsByChecker.get(options.checker.name) ?? [];
}
