import type { ResolvedLiminaConfig } from '#config/runner';
import { compareCodeUnits } from '#utils/collections';
import { createProjectDependencyCaches } from '../project-dependencies/runner';
import { createWorkspaceSourceBoundary } from '../typescript-semantic';
import type { WorkspaceRegionPathIndex } from '../workspace/validated-context';
import {
  type GovernedBuildOwner,
  processFrameworkSourceReferences,
} from './framework-reference-inference';
import { addImplicitProjectReferences } from './implicit-references';
import { resolveBuildGraphImportAnalysis } from './import-analysis-context';
import { createDtsProjectsBySourcePath } from './project-indexes';
import {
  processProjectReferenceImports,
  type ReferenceImportContext,
} from './reference-imports';
import type {
  GeneratedBuildModule,
  GeneratedDependencyEdge,
  GovernedSourceUnit,
  InferredProjectReferenceCollection,
  PrepareGeneratedTsconfigGraphOptions,
  SourceProject,
} from './types';

function createOwnerLookup(
  governedSources: readonly GovernedSourceUnit[],
): Map<string, string[]> {
  const ownersByFile = new Map<string, string[]>();
  for (const unit of governedSources) {
    addGovernedSourceOwners(ownersByFile, unit);
  }
  return ownersByFile;
}

function addGovernedSourceOwners(
  ownersByFile: Map<string, string[]>,
  unit: GovernedSourceUnit,
): void {
  for (const fileName of unit.ownedFileNames) {
    const owners = ownersByFile.get(fileName) ?? [];
    owners.push(unit.configPath);
    ownersByFile.set(fileName, owners);
  }
}

function createPrimaryProjectsByConfigPath(
  projects: readonly SourceProject[],
): Map<string, SourceProject> {
  return new Map(projects.map((project) => [project.configPath, project]));
}

function createGovernedBuildOwners(options: {
  governedSources: readonly GovernedSourceUnit[];
  sourceToBuildByChecker: ReadonlyMap<
    string,
    ReadonlyMap<string, GeneratedBuildModule>
  >;
}): Map<string, GovernedBuildOwner> {
  const owners = new Map<string, GovernedBuildOwner>();
  for (const unit of options.governedSources) {
    const buildModule = getGovernedBuildModule({ ...options, unit });
    owners.set(unit.configPath, {
      checkerName: unit.primaryCheckerName,
      ...(buildModule === undefined ? {} : { buildModule }),
    });
  }
  return owners;
}

function getGovernedBuildModule(options: {
  sourceToBuildByChecker: ReadonlyMap<
    string,
    ReadonlyMap<string, GeneratedBuildModule>
  >;
  unit: GovernedSourceUnit;
}): GeneratedBuildModule | undefined {
  return options.sourceToBuildByChecker
    .get(options.unit.primaryCheckerName)
    ?.get(options.unit.configPath);
}

function compareDependencyEdges(
  left: GeneratedDependencyEdge,
  right: GeneratedDependencyEdge,
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

function addImplicitReferences(options: {
  config: ResolvedLiminaConfig;
  localDtsProjectsBySourcePath: Map<string, SourceProject[]>;
  problems: string[];
  projects: SourceProject[];
}): void {
  for (const project of options.projects) {
    addImplicitProjectReferences({
      config: options.config,
      localDtsProjectsBySourcePath: options.localDtsProjectsBySourcePath,
      problems: options.problems,
      project,
    });
  }
}

function processReferenceImports(options: {
  context: ReferenceImportContext;
  governedSources: GovernedSourceUnit[];
  projects: SourceProject[];
}): void {
  const sourcesByConfigPath = new Map(
    options.governedSources.map((source) => [source.configPath, source]),
  );
  for (const project of options.projects) {
    processProjectReferenceImports({
      context: options.context,
      project,
      source: sourcesByConfigPath.get(project.configPath),
    });
  }
}

export function inferProjectReferences(options: {
  activatedRegions: WorkspaceRegionPathIndex;
  config: ResolvedLiminaConfig;
  governedSources: GovernedSourceUnit[];
  importAnalysisContext?: PrepareGeneratedTsconfigGraphOptions['importAnalysisContext'];
  ownerGovernedSources?: GovernedSourceUnit[];
  ownerProjects?: SourceProject[];
  primaryProjects: SourceProject[];
  projects: SourceProject[];
  sourceToBuildByChecker: ReadonlyMap<
    string,
    ReadonlyMap<string, GeneratedBuildModule>
  >;
}): InferredProjectReferenceCollection {
  const ownerProjects = options.ownerProjects ?? options.projects;
  const ownerGovernedSources =
    options.ownerGovernedSources ?? options.governedSources;
  const problems: string[] = [];
  const dependencyEdgesByKey = new Map<string, GeneratedDependencyEdge>();
  const localDtsProjectsBySourcePath = createDtsProjectsBySourcePath(
    options.projects,
  );
  addImplicitReferences({
    config: options.config,
    localDtsProjectsBySourcePath,
    problems,
    projects: options.projects,
  });
  const context: ReferenceImportContext = {
    activatedRegions: options.activatedRegions,
    config: options.config,
    dtsProjectsBySourcePath: createDtsProjectsBySourcePath(ownerProjects),
    fileOwnerLookup: createOwnerLookup(ownerGovernedSources),
    importAnalysis: resolveBuildGraphImportAnalysis(options),
    projectDependencyCaches: createProjectDependencyCaches(),
    problems,
    dependencyEdgesByKey,
    workspaceSourceBoundary: createWorkspaceSourceBoundary([
      ...ownerProjects.flatMap((project) => project.fileNames),
      ...ownerGovernedSources.flatMap((source) => source.ownedFileNames),
    ]),
  };
  processReferenceImports({
    context,
    governedSources: options.governedSources,
    projects: options.projects,
  });
  processFrameworkSourceReferences({
    buildOwnersByConfigPath: createGovernedBuildOwners({
      governedSources: ownerGovernedSources,
      sourceToBuildByChecker: options.sourceToBuildByChecker,
    }),
    context,
    governedSources: options.governedSources,
    primaryProjectsByConfigPath: createPrimaryProjectsByConfigPath(
      options.primaryProjects,
    ),
  });
  return {
    problems,
    dependencyEdges: [...dependencyEdgesByKey.values()].sort(
      compareDependencyEdges,
    ),
  };
}
