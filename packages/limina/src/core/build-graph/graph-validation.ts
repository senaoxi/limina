import type {
  ResolvedCheckerConfig,
  ResolvedLiminaConfig,
} from '#config/runner';
import { compareCodeUnits } from '#utils/collections';
import type { WorkspaceRegionPathIndex } from '../workspace/validated-context';
import { addCrossCheckerProviderCompatibilityProblems } from './cross-checker-compatibility';
import {
  addDuplicateCheckerOwnershipProblems,
  addOverlappingCheckerEntryProblems,
  addUnsupportedSourceConfigExtensionProblems,
} from './generated/validation';
import { createCheckerOutputGraph } from './output-graph';
import type { GeneratedGraphPreparationState } from './prepare-state';
import { getCheckerProjects } from './prepare-state';
import { createGeneratedGraphStructuredError } from './problems';
import { createSourceProjectsByDtsPath } from './project-indexes';
import { addOutputBuildOwnerCollisionProblems } from './provider-selection';
import { inferProjectReferences } from './reference-inference';
import { createEmptySourceConfigCollection } from './source-config-collection';
import { addActivatedRegionSourceProjectProblems } from './source-projects';
import type { PrepareGeneratedTsconfigGraphOptions } from './types';

function getAllProjects(
  state: GeneratedGraphPreparationState,
): ReturnType<typeof getCheckerProjects> {
  return [...state.projectsByChecker.values()].flat();
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
  addUnsupportedSourceConfigExtensionProblems({
    config: options.config,
    problems: options.state.problems,
    projectConfigCache: options.projectConfigCache,
    projects: options.allProjects,
  });
}

function addInferredReferences(options: {
  activatedRegions: WorkspaceRegionPathIndex;
  allProjects: ReturnType<typeof getAllProjects>;
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
      ownerProjects: options.allProjects,
      projects: getCheckerProjects({ checker, state: options.state }),
    });
    options.state.problems.push(...collection.problems);
    options.state.providerEdges.push(...collection.providerEdges);
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

function compareProviderEdges(
  left: GeneratedGraphPreparationState['providerEdges'][number],
  right: GeneratedGraphPreparationState['providerEdges'][number],
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
  addProjectValidationProblems({ ...options, allProjects });
  addInferredReferences({ ...options, allProjects });
  addCrossCheckerProviderCompatibilityProblems({
    config: options.config,
    problems: options.state.problems,
    projects: allProjects,
    providerEdges: options.state.providerEdges,
  });
  addCheckerOutputGraphs({ ...options, allProjects });
  options.state.providerEdges.sort(compareProviderEdges);
  if (options.state.problems.length > 0) {
    throw createGeneratedGraphStructuredError({
      config: options.config,
      fallback: 'Failed to prepare generated tsconfig graph.',
      problems: options.state.problems,
    });
  }
}
