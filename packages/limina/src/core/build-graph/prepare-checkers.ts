import {
  type CheckerProjectConfigCache,
  isBuildCapablePreset,
} from '#checkers';
import type { ResolvedLiminaConfig } from '#config/runner';
import type { WorkspaceRegionPathIndex } from '../workspace/validated-context';
import type { CheckerOwnershipPlan } from './checker-ownership-types';
import { getGeneratedCheckerEntryPath } from './generated/paths';
import { createGovernedSourceUnit } from './governed-sources';
import { collectCheckerSourceConfigs } from './source-config-root-collection';
import { createSolutionProject, createSourceProject } from './source-projects';
import type {
  GovernedSourceUnit,
  PreparedCheckerGraph,
  ResolvedCheckerEntrySelection,
  SolutionProject,
  SourceProject,
} from './types';

function getPackageRootDir(options: {
  activatedRegions: WorkspaceRegionPathIndex;
  sourceConfigPath: string;
}): string {
  return options.activatedRegions.findPackageForPath(options.sourceConfigPath)!
    .directory;
}

function getSemanticAuthority(options: {
  configPath: string;
  ownershipPlan: CheckerOwnershipPlan;
}) {
  const authority = options.ownershipPlan.typeConfigs.get(
    options.configPath,
  )?.frozenSemanticAuthority;
  if (authority === undefined) {
    throw new Error(
      `Missing frozen semantic authority for ${options.configPath}.`,
    );
  }
  return authority;
}

function createCheckerSolutions(options: {
  activatedRegions: WorkspaceRegionPathIndex;
  collection: PreparedCheckerGraph['collection'];
  config: ResolvedLiminaConfig;
  projectConfigCache?: CheckerProjectConfigCache;
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

function applyBuildProjections(options: {
  collection: PreparedCheckerGraph['collection'];
  governedSources: GovernedSourceUnit[];
}): void {
  for (const unit of options.governedSources) {
    const buildModule = createBuildModule(unit);
    if (buildModule === null) {
      options.collection.buildModulesBySourcePath.delete(unit.configPath);
      continue;
    }
    options.collection.buildModulesBySourcePath.set(
      unit.configPath,
      buildModule,
    );
  }
}

function createBuildModule(
  unit: GovernedSourceUnit,
): PreparedCheckerGraph['collection']['buildModulesBySourcePath'] extends Map<
  string,
  infer Module
>
  ? Module | null
  : never {
  const projection = unit.buildProjection;
  if (projection.kind === 'framework-checker') return null;
  return 'buildConfigPath' in projection
    ? { kind: 'solution', path: projection.buildConfigPath }
    : { kind: 'project', path: projection.dtsConfigPath };
}

function getDeclarationProjects(options: {
  governedSources: GovernedSourceUnit[];
  primaryProjects: SourceProject[];
}): SourceProject[] {
  const declarationUnitsByConfigPath = new Map(
    options.governedSources.flatMap((unit) =>
      'dtsConfigPath' in unit.buildProjection
        ? [[unit.configPath, unit] as const]
        : [],
    ),
  );
  return options.primaryProjects.flatMap((project) =>
    createDeclarationProject(project, declarationUnitsByConfigPath),
  );
}

function createDeclarationProject(
  project: SourceProject,
  unitsByConfigPath: ReadonlyMap<string, GovernedSourceUnit>,
): SourceProject[] {
  const unit = unitsByConfigPath.get(project.configPath);
  if (unit === undefined) return [];
  return [{ ...project, fileNames: [...unit.declarationFileNames] }];
}

function getProjectionReferences(
  projection: Exclude<
    GovernedSourceUnit['buildProjection'],
    { kind: 'framework-checker' }
  >,
): Set<string> {
  return new Set(
    'dtsConfigPath' in projection ? [projection.dtsConfigPath] : [],
  );
}

function createProjectionSolution(unit: GovernedSourceUnit): SolutionProject[] {
  const projection = unit.buildProjection;
  if (projection.kind === 'framework-checker') return [];
  if (!('buildConfigPath' in projection)) return [];
  return [
    {
      buildConfigPath: projection.buildConfigPath,
      checkerName: unit.primaryCheckerName,
      configPath: unit.configPath,
      packageRootDir: unit.packageRootDir,
      references: getProjectionReferences(projection),
    },
  ];
}

function createProjectionSolutions(
  governedSources: GovernedSourceUnit[],
): SolutionProject[] {
  return governedSources.flatMap(createProjectionSolution);
}

function getCheckerParsingOptions(
  checkerName: ResolvedCheckerEntrySelection['checker']['name'],
): {
  checkerPreset: ResolvedCheckerEntrySelection['checker']['name'];
  discoveryExtensions?: string[];
} {
  if (isBuildCapablePreset(checkerName)) {
    return { checkerPreset: checkerName };
  }
  return {
    checkerPreset: 'tsc',
    discoveryExtensions: checkerName === 'astro' ? ['.astro'] : ['.svelte'],
  };
}

function createGraphSolutions(options: {
  activatedRegions: WorkspaceRegionPathIndex;
  buildCapable: boolean;
  collection: PreparedCheckerGraph['collection'];
  config: ResolvedLiminaConfig;
  governedSources: GovernedSourceUnit[];
  selection: ResolvedCheckerEntrySelection;
}): SolutionProject[] {
  if (!options.buildCapable) return [];
  return [
    ...createCheckerSolutions(options),
    ...createProjectionSolutions(options.governedSources),
  ];
}

export function prepareCheckerGraph(options: {
  activatedRegions: WorkspaceRegionPathIndex;
  config: ResolvedLiminaConfig;
  projectConfigCache?: CheckerProjectConfigCache;
  selection: ResolvedCheckerEntrySelection;
  explicitOwnerByConfigPath?: ReadonlyMap<
    string,
    ResolvedCheckerEntrySelection['checker']['name']
  >;
  inheritedOwnerByConfigPath?: Map<
    string,
    ResolvedCheckerEntrySelection['checker']['name']
  >;
  ownershipPlan: CheckerOwnershipPlan;
}): PreparedCheckerGraph {
  const parsing = getCheckerParsingOptions(options.selection.checker.name);
  const collection = collectCheckerSourceConfigs({
    activatedRegions: options.activatedRegions,
    checkerName: options.selection.checker.name,
    checkerPreset: parsing.checkerPreset,
    discoveryExtensions: parsing.discoveryExtensions,
    config: options.config,
    entryConfigPaths: options.selection.selection.effectiveEntryPaths,
    explicitOwnerByConfigPath: options.explicitOwnerByConfigPath,
    inheritedOwnerByConfigPath: options.inheritedOwnerByConfigPath,
    projectConfigCache: options.projectConfigCache,
  });
  const primaryProjects = [...collection.projectConfigPaths]
    .sort()
    .map((sourceConfigPath) =>
      createSourceProject({
        checkerName: options.selection.checker.name,
        checkerPreset: parsing.checkerPreset,
        config: options.config,
        discoveryExtensions: parsing.discoveryExtensions,
        packageRootDir: getPackageRootDir({
          activatedRegions: options.activatedRegions,
          sourceConfigPath,
        }),
        projectConfigCache: options.projectConfigCache,
        semanticAuthority: getSemanticAuthority({
          configPath: sourceConfigPath,
          ownershipPlan: options.ownershipPlan,
        }),
        sourceConfigPath,
      }),
    );
  const governedSources = primaryProjects.map((project) =>
    createGovernedSourceUnit({
      activatedRegions: options.activatedRegions,
      config: options.config,
      project,
      projectConfigCache: options.projectConfigCache,
    }),
  );
  applyBuildProjections({ collection, governedSources });
  const projects = getDeclarationProjects({
    governedSources,
    primaryProjects,
  });
  return {
    checker: options.selection.checker,
    collection,
    entryPath: getGeneratedCheckerEntryPath({
      checkerName: options.selection.checker.name,
      rootDir: options.config.rootDir,
    }),
    governedSources,
    dependencyEdges: [],
    primaryProjects,
    projects,
    rootBuildPaths: getRootBuildPaths(collection),
    solutions: createGraphSolutions({
      activatedRegions: options.activatedRegions,
      buildCapable: isBuildCapablePreset(options.selection.checker.name),
      collection,
      config: options.config,
      governedSources,
      selection: options.selection,
    }),
  };
}
