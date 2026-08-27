import { isBuildCapablePreset } from '#checkers';
import type { ResolvedCheckerConfig } from '#config/runner';
import type { CheckerOwnershipPlan } from './checker-ownership-types';
import type {
  CheckerSourceConfigCollection,
  GeneratedBuildModule,
  GeneratedDependencyEdge,
  GeneratedGraphWriteContext,
  GeneratedOutputDeclarationCopyContext,
  GovernedSourceUnit,
  OutputSolutionProject,
  PreparedCheckerGraph,
  SolutionProject,
  SourceProject,
} from './types';

export interface GeneratedGraphPreparationState {
  checkerOwnershipPlan: CheckerOwnershipPlan;
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
  primaryProjectsByChecker: Map<string, SourceProject[]>;
  projectsByChecker: Map<string, SourceProject[]>;
  governedSourcesByChecker: Map<string, GovernedSourceUnit[]>;
  dependencyEdges: GeneratedDependencyEdge[];
  rootBuildPathsByChecker: Map<string, string[]>;
  solutionsByChecker: Map<string, SolutionProject[]>;
  sourceToBuildByChecker: Map<string, Map<string, GeneratedBuildModule>>;
  writeContext: GeneratedGraphWriteContext;
}

export function createGeneratedGraphPreparationState(
  rootDir: string,
  checkerOwnershipPlan: CheckerOwnershipPlan,
): GeneratedGraphPreparationState {
  return {
    checkerOwnershipPlan,
    checkerCollectionsByName: new Map(),
    checkerEntries: new Map(),
    configToOutputBuildByChecker: new Map(),
    outputDeclarationCopiesByChecker: new Map(),
    outputProjectsByChecker: new Map(),
    outputSolutionsByChecker: new Map(),
    problems: [],
    primaryProjectsByChecker: new Map(),
    projectsByChecker: new Map(),
    governedSourcesByChecker: new Map(),
    dependencyEdges: [],
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
  options.state.dependencyEdges.push(
    ...options.preparedChecker.dependencyEdges,
  );
  options.state.checkerCollectionsByName.set(
    checkerName,
    options.preparedChecker.collection,
  );
  options.state.projectsByChecker.set(
    checkerName,
    options.preparedChecker.projects,
  );
  options.state.primaryProjectsByChecker.set(
    checkerName,
    options.preparedChecker.primaryProjects,
  );
  options.state.governedSourcesByChecker.set(
    checkerName,
    options.preparedChecker.governedSources,
  );
  options.state.solutionsByChecker.set(
    checkerName,
    options.preparedChecker.solutions,
  );
  options.state.sourceToBuildByChecker.set(
    checkerName,
    options.preparedChecker.collection.buildModulesBySourcePath,
  );
  if (isBuildCapablePreset(checkerName)) {
    options.state.rootBuildPathsByChecker.set(
      checkerName,
      options.preparedChecker.rootBuildPaths,
    );
    options.state.checkerEntries.set(
      checkerName,
      options.preparedChecker.entryPath,
    );
  }
}

export function getCheckerProjects(options: {
  checker: ResolvedCheckerConfig;
  state: GeneratedGraphPreparationState;
}): SourceProject[] {
  return options.state.projectsByChecker.get(options.checker.name) ?? [];
}
