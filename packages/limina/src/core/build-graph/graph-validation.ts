import type {
  ResolvedCheckerConfig,
  ResolvedLiminaInputs,
} from '#config/runner';
import { toRelativePath } from '#utils/path';
import { createProjectDependencyCaches } from '../project-dependencies/cache';
import type { ProjectDependencyCaches } from '../project-dependencies/contracts';
import type { WorkspaceRegionPathIndex } from '../workspace/validated-context';
import { finishAnalysisOutcome } from './analysis-outcome';
import {
  addFrameworkOutputProblems,
  synchronizeProjectionSolutionReferences,
} from './build-projections';
import {
  assertGeneratedGraphAdmission,
  createCandidateBuildPlan,
} from './candidate-build-plan';
import { compareDependencyEdges } from './dependency-edge-order';
import {
  addDuplicateCheckerOwnershipProblems,
  addOverlappingCheckerEntryProblems,
} from './generated/validation';
import { mergeNativeAnalysis } from './native-analysis-evidence';
import { createCheckerOutputGraph } from './output-graph';
import type { GeneratedGraphPreparationState } from './prepare-state';
import { getCheckerProjects } from './prepare-state';
import { createSourceProjectsByDtsPath } from './project-indexes';
import { addOutputBuildOwnerCollisionProblems } from './provider-selection';
import { inferProjectReferences } from './reference-inference';
import { createEmptySourceConfigCollection } from './source-config-collection';
import { addActivatedRegionSourceProjectProblems } from './source-projects';
import type { PrepareGeneratedTsconfigGraphOptions } from './types';
function getAllProjects(
  state: GeneratedGraphPreparationState,
): ReturnType<typeof getCheckerProjects> {
  return state.projectsByChecker.values().toArray().flat();
}
function getAllGovernedSources(state: GeneratedGraphPreparationState) {
  return state.governedSourcesByChecker.values().toArray().flat();
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
  config: ResolvedLiminaInputs;
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
  allPrimaryProjects: ReturnType<typeof getAllProjects>;
  config: ResolvedLiminaInputs;
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
  config: ResolvedLiminaInputs;
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
  config: ResolvedLiminaInputs,
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
  config: ResolvedLiminaInputs;
  importAnalysisContext?: PrepareGeneratedTsconfigGraphOptions['importAnalysisContext'];
  projectDependencyCaches?: ProjectDependencyCaches;
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
      projectDependencyCaches: options.projectDependencyCaches,
      projects: getCheckerProjects({ checker, state: options.state }),
      sourceToBuildByChecker: options.state.sourceToBuildByChecker,
    });
    mergeNativeAnalysis(options.state.dependencyAnalysis, collection.analysis);
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
  config: ResolvedLiminaInputs;
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
  config: ResolvedLiminaInputs;
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

export function analyzeAndCompleteGeneratedGraph(options: {
  activatedRegions: WorkspaceRegionPathIndex;
  checkers: ResolvedCheckerConfig[];
  config: ResolvedLiminaInputs;
  importAnalysisContext?: PrepareGeneratedTsconfigGraphOptions['importAnalysisContext'];
  projectDependencyCaches?: ProjectDependencyCaches;
  projectConfigCache?: PrepareGeneratedTsconfigGraphOptions['projectConfigCache'];
  state: GeneratedGraphPreparationState;
}): void {
  addCheckerOwnershipProblems(options);
  const allProjects = getAllProjects(options.state);
  const allPrimaryProjects = options.state.primaryProjectsByChecker
    .values()
    .toArray()
    .flat();
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
  const { dependencyAnalysis: analysis } = options.state;
  analysis.candidate = createCandidateBuildPlan(
    allGovernedSources,
    options.state.dependencyEdges,
  );
  analysis.diagnostics.push(...options.state.problems);
  analysis.diagnostics = [...new Set(analysis.diagnostics)];
  finishAnalysisOutcome(
    analysis,
    options.projectDependencyCaches ?? createProjectDependencyCaches(),
    {
      scope: 'generated-graph',
      state: options.state.problems.length === 0 ? 'compliant' : 'violations',
      diagnostics: [...options.state.problems],
    },
  );
}

export function validateAndCompleteGeneratedGraph(
  options: Parameters<typeof analyzeAndCompleteGeneratedGraph>[0],
): void {
  analyzeAndCompleteGeneratedGraph(options);
  assertGeneratedGraphAdmission({
    ...options,
    allowPendingFinalValidation: true,
  });
}
