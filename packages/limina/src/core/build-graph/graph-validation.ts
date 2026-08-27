import type {
  ResolvedCheckerConfig,
  ResolvedLiminaConfig,
} from '#config/runner';
import { compareCodeUnits } from '#utils/collections';
import { toRelativePath } from '#utils/path';
import type { WorkspaceRegionPathIndex } from '../workspace/validated-context';
import {
  addFrameworkOutputProblems,
  synchronizeProjectionSolutionReferences,
} from './build-projections';
import {
  addDuplicateCheckerOwnershipProblems,
  addOverlappingCheckerEntryProblems,
} from './generated/validation';
import { createCheckerOutputGraph } from './output-graph';
import type { GeneratedGraphPreparationState } from './prepare-state';
import { getCheckerProjects } from './prepare-state';
import { createGeneratedGraphStructuredError } from './problems';
import { createSourceProjectsByDtsPath } from './project-indexes';
import { addOutputBuildOwnerCollisionProblems } from './provider-selection';
import { inferProjectReferences } from './reference-inference';
import { createEmptySourceConfigCollection } from './source-config-root-collection';
import { addActivatedRegionSourceProjectProblems } from './source-projects';
import type { PrepareGeneratedTsconfigGraphOptions } from './types';

function getAllProjects(
  state: GeneratedGraphPreparationState,
): ReturnType<typeof getCheckerProjects> {
  return [...state.projectsByChecker.values()].flat();
}

function getAllPrimaryProjects(
  state: GeneratedGraphPreparationState,
): ReturnType<typeof getCheckerProjects> {
  return [...state.primaryProjectsByChecker.values()].flat();
}

function getAllGovernedSources(state: GeneratedGraphPreparationState) {
  return [...state.governedSourcesByChecker.values()].flat();
}

function getCheckerGovernedSources(options: {
  checkerName: string;
  state: GeneratedGraphPreparationState;
}) {
  return options.state.governedSourcesByChecker.get(options.checkerName) ?? [];
}

function getCheckerPrimaryProjects(options: {
  checkerName: string;
  state: GeneratedGraphPreparationState;
}) {
  return options.state.primaryProjectsByChecker.get(options.checkerName) ?? [];
}

function addCheckerOwnershipProblems(options: {
  checkers: ResolvedCheckerConfig[];
  config: ResolvedLiminaConfig;
  projectConfigCache?: PrepareGeneratedTsconfigGraphOptions['projectConfigCache'];
  state: GeneratedGraphPreparationState;
}): void {
  const base = {
    checkerCollectionsByName: options.state.checkerCollectionsByName,
    checkers: options.checkers,
    problems: options.state.problems,
    rootDir: options.config.rootDir,
  };
  addOverlappingCheckerEntryProblems(base);
  addDuplicateCheckerOwnershipProblems(base);
}

function addProjectValidationProblems(options: {
  activatedRegions: WorkspaceRegionPathIndex;
  allProjects: ReturnType<typeof getAllProjects>;
  allPrimaryProjects: ReturnType<typeof getAllPrimaryProjects>;
  config: ResolvedLiminaConfig;
  projectConfigCache?: PrepareGeneratedTsconfigGraphOptions['projectConfigCache'];
  state: GeneratedGraphPreparationState;
}): void {
  addActivatedRegionSourceProjectProblems({
    activatedRegions: options.activatedRegions,
    config: options.config,
    problems: options.state.problems,
    projects: options.allProjects,
  });
  addOutputBuildOwnerCollisionProblems({
    config: options.config,
    problems: options.state.problems,
    projects: options.allProjects,
  });
}

function addDeclarationCheckerInvariantProblems(options: {
  config: ResolvedLiminaConfig;
  state: GeneratedGraphPreparationState;
}): void {
  options.state.problems.push(
    ...options.state.dependencyEdges
      .filter(isInvalidDeclarationCheckerEdge)
      .map((edge) => formatDeclarationCheckerInvariant(options.config, edge)),
  );
}

function isInvalidDeclarationCheckerEdge(
  edge: GeneratedGraphPreparationState['dependencyEdges'][number],
): boolean {
  return (
    edge.kind === 'declaration-provider' &&
    (edge.fromChecker !== edge.toChecker || edge.cacheReuse !== 'reusable')
  );
}

function formatDeclarationCheckerInvariant(
  config: ResolvedLiminaConfig,
  edge: GeneratedGraphPreparationState['dependencyEdges'][number],
): string {
  return [
    'Build checker ownership invariant failed:',
    `  consumer: ${edge.fromChecker} (${toRelativePath(config.rootDir, edge.fromConfigPath)})`,
    `  provider: ${edge.toChecker} (${toRelativePath(config.rootDir, edge.toConfigPath)})`,
    `  import: ${edge.file} -> ${edge.importedSpecifier}`,
    '  reason: every internal declaration-provider edge must use one identical build checker and reusable cache domain.',
    '  fix: align checker ownership or split the declaration boundary.',
  ].join('\n');
}

function addInferredReferences(options: {
  activatedRegions: WorkspaceRegionPathIndex;
  allProjects: ReturnType<typeof getAllProjects>;
  allGovernedSources: ReturnType<typeof getAllGovernedSources>;
  checkers: ResolvedCheckerConfig[];
  config: ResolvedLiminaConfig;
  importAnalysisContext?: PrepareGeneratedTsconfigGraphOptions['importAnalysisContext'];
  projectConfigCache?: PrepareGeneratedTsconfigGraphOptions['projectConfigCache'];
  state: GeneratedGraphPreparationState;
}): void {
  for (const checker of options.checkers) {
    const collection = inferProjectReferences({
      activatedRegions: options.activatedRegions,
      config: options.config,
      importAnalysisContext: options.importAnalysisContext,
      governedSources: getCheckerGovernedSources({
        checkerName: checker.name,
        state: options.state,
      }),
      ownerGovernedSources: options.allGovernedSources,
      ownerProjects: options.allProjects,
      primaryProjects: getCheckerPrimaryProjects({
        checkerName: checker.name,
        state: options.state,
      }),
      projects: getCheckerProjects({ checker, state: options.state }),
      sourceToBuildByChecker: options.state.sourceToBuildByChecker,
    });
    options.state.problems.push(...collection.problems);
    options.state.dependencyEdges.push(...collection.dependencyEdges);
  }
}

function synchronizeBuildProjectionSolutions(
  state: GeneratedGraphPreparationState,
): void {
  for (const [checkerName, governedSources] of state.governedSourcesByChecker) {
    synchronizeProjectionSolutionReferences({
      governedSources,
      solutions: state.solutionsByChecker.get(checkerName) ?? [],
    });
  }
}

function addCheckerOutputGraph(options: {
  allProjectsByDtsPath: ReturnType<typeof createSourceProjectsByDtsPath>;
  checker: ResolvedCheckerConfig;
  config: ResolvedLiminaConfig;
  state: GeneratedGraphPreparationState;
}): void {
  const collection =
    options.state.checkerCollectionsByName.get(options.checker.name) ??
    createEmptySourceConfigCollection([]);
  const outputGraph = createCheckerOutputGraph({
    allProjectsByDtsPath: options.allProjectsByDtsPath,
    checker: options.checker,
    collection,
    config: options.config,
    problems: options.state.problems,
    projects: getCheckerProjects({
      checker: options.checker,
      state: options.state,
    }),
  });
  options.state.configToOutputBuildByChecker.set(
    options.checker.name,
    outputGraph.configToOutputBuild,
  );
  options.state.outputDeclarationCopiesByChecker.set(
    options.checker.name,
    outputGraph.outputDeclarationCopies,
  );
  options.state.outputProjectsByChecker.set(
    options.checker.name,
    outputGraph.outputProjects,
  );
  options.state.outputSolutionsByChecker.set(
    options.checker.name,
    outputGraph.outputSolutions,
  );
}

function addCheckerOutputGraphs(options: {
  allProjects: ReturnType<typeof getAllProjects>;
  checkers: ResolvedCheckerConfig[];
  config: ResolvedLiminaConfig;
  state: GeneratedGraphPreparationState;
}): void {
  const allProjectsByDtsPath = createSourceProjectsByDtsPath(
    options.allProjects,
  );
  for (const checker of options.checkers) {
    addCheckerOutputGraph({
      allProjectsByDtsPath,
      checker,
      config: options.config,
      state: options.state,
    });
  }
}

function compareDependencyEdges(
  left: GeneratedGraphPreparationState['dependencyEdges'][number],
  right: GeneratedGraphPreparationState['dependencyEdges'][number],
): number {
  const comparisons = [
    compareCodeUnits(left.fromChecker, right.fromChecker),
    compareCodeUnits(left.fromConfigPath, right.fromConfigPath),
    compareCodeUnits(left.toChecker, right.toChecker),
    compareCodeUnits(left.toConfigPath, right.toConfigPath),
    compareCodeUnits(left.file, right.file),
    compareCodeUnits(left.importedSpecifier, right.importedSpecifier),
  ];
  return comparisons.find((comparison) => comparison !== 0) ?? 0;
}

export function validateAndCompleteGeneratedGraph(options: {
  activatedRegions: WorkspaceRegionPathIndex;
  checkers: ResolvedCheckerConfig[];
  config: ResolvedLiminaConfig;
  importAnalysisContext?: PrepareGeneratedTsconfigGraphOptions['importAnalysisContext'];
  projectConfigCache?: PrepareGeneratedTsconfigGraphOptions['projectConfigCache'];
  state: GeneratedGraphPreparationState;
}): void {
  addCheckerOwnershipProblems(options);
  const allProjects = getAllProjects(options.state);
  const allPrimaryProjects = getAllPrimaryProjects(options.state);
  const allGovernedSources = getAllGovernedSources(options.state);
  addProjectValidationProblems({
    ...options,
    allPrimaryProjects,
    allProjects,
  });
  addFrameworkOutputProblems({
    config: options.config,
    governedSources: allGovernedSources,
    problems: options.state.problems,
  });
  addInferredReferences({
    ...options,
    allGovernedSources,
    allProjects,
  });
  synchronizeBuildProjectionSolutions(options.state);
  addDeclarationCheckerInvariantProblems(options);
  addCheckerOutputGraphs({ ...options, allProjects });
  options.state.dependencyEdges.sort(compareDependencyEdges);
  if (options.state.problems.length > 0) {
    throw createGeneratedGraphStructuredError({
      config: options.config,
      fallback: 'Failed to prepare generated tsconfig graph.',
      problems: options.state.problems,
    });
  }
}
