import type { ResolvedLiminaConfig } from '#config/runner';
import type { WorkspaceRegionPathIndex } from '../workspace/validated-context';
import { getGeneratedCheckerEntryPath } from './generated/paths';
import { collectCheckerSourceConfigs } from './source-config-collection';
import { createSolutionProject, createSourceProject } from './source-projects';
import type {
  PreparedCheckerGraph,
  ResolvedCheckerEntrySelection,
} from './types';

function getPackageRootDir(options: {
  activatedRegions: WorkspaceRegionPathIndex;
  sourceConfigPath: string;
}): string {
  return options.activatedRegions.findPackageForPath(options.sourceConfigPath)!
    .directory;
}

function createCheckerSolutions(options: {
  activatedRegions: WorkspaceRegionPathIndex;
  collection: PreparedCheckerGraph['collection'];
  config: ResolvedLiminaConfig;
  selection: ResolvedCheckerEntrySelection;
}): ReturnType<typeof createSolutionProject>[] {
  return [...options.collection.solutionConfigPaths]
    .sort()
    .map((sourceConfigPath) =>
      createSolutionProject({
        checkerName: options.selection.checker.name,
        collection: options.collection,
        config: options.config,
        packageRootDir: getPackageRootDir({
          activatedRegions: options.activatedRegions,
          sourceConfigPath,
        }),
        sourceConfigPath,
      }),
    );
}

function getRootBuildPaths(
  collection: PreparedCheckerGraph['collection'],
): string[] {
  return collection.rootConfigPaths
    .map((sourceConfigPath) =>
      collection.buildModulesBySourcePath.get(sourceConfigPath),
    )
    .filter((module) => Boolean(module))
    .map((module) => module!.path);
}

export function prepareCheckerGraph(options: {
  activatedRegions: WorkspaceRegionPathIndex;
  config: ResolvedLiminaConfig;
  selection: ResolvedCheckerEntrySelection;
}): PreparedCheckerGraph {
  const collection = collectCheckerSourceConfigs({
    activatedRegions: options.activatedRegions,
    checkerName: options.selection.checker.name,
    checkerPreset: options.selection.checker.preset,
    config: options.config,
    entryConfigPaths: options.selection.selection.effectiveEntryPaths,
  });
  const projects = [...collection.projectConfigPaths]
    .sort()
    .map((sourceConfigPath) =>
      createSourceProject({
        checkerName: options.selection.checker.name,
        checkerPreset: options.selection.checker.preset,
        config: options.config,
        packageRootDir: getPackageRootDir({
          activatedRegions: options.activatedRegions,
          sourceConfigPath,
        }),
        sourceConfigPath,
      }),
    );
  return {
    checker: options.selection.checker,
    collection,
    entryPath: getGeneratedCheckerEntryPath({
      checkerName: options.selection.checker.name,
      rootDir: options.config.rootDir,
    }),
    projects,
    rootBuildPaths: getRootBuildPaths(collection),
    solutions: createCheckerSolutions({
      activatedRegions: options.activatedRegions,
      collection,
      config: options.config,
      selection: options.selection,
    }),
  };
}

export function prepareCheckerGraphs(options: {
  activatedRegions: WorkspaceRegionPathIndex;
  config: ResolvedLiminaConfig;
  selections: ResolvedCheckerEntrySelection[];
}): PreparedCheckerGraph[] {
  return options.selections.map((selection) =>
    prepareCheckerGraph({ ...options, selection }),
  );
}
