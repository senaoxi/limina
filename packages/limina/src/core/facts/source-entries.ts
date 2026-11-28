import type { CheckerProjectParseContext } from '#checkers';
import type { AnalysisProviderSet } from '#core';
import { uniqueCodeUnitSortedStrings as uniqueSortedStrings } from '#utils/collections';
import { existsSync } from 'node:fs';
import type {
  GeneratedTsconfigGraphResult,
  GovernedSourceUnit,
} from '../build-graph/types';
import type { ProjectInfo } from '../import-graph/project-types';
import { createUnitByProjectPath } from '../project-dependencies/project-alignment';
import type { WorkspaceLookupIndex } from '../workspace/lookup';

export interface SourceProjectEntry {
  checkerNames: string[];
  companionFileNames: string[];
  fileNames: string[];
  project: ProjectInfo;
}

function filterProjectInfoToActivatedRegion(
  project: ProjectInfo,
  workspaceLookup: WorkspaceLookupIndex,
): ProjectInfo {
  return {
    ...project,
    fileNames: project.fileNames.filter((fileName) =>
      workspaceLookup.isInsideActivatedRegion(fileName),
    ),
    ownedFileNames: project.ownedFileNames.filter((fileName) =>
      workspaceLookup.isInsideActivatedRegion(fileName),
    ),
  };
}

function addCheckerName(
  namesByPath: Map<string, string[]>,
  configPath: string,
  checkerName: string,
): void {
  namesByPath.set(
    configPath,
    uniqueSortedStrings([...(namesByPath.get(configPath) ?? []), checkerName]),
  );
}

function addCheckerMappings(options: {
  checkerName: string;
  namesByPath: Map<string, string[]>;
  sourceToDts: Map<string, string>;
}): void {
  for (const dtsConfigPath of options.sourceToDts.values()) {
    addCheckerName(options.namesByPath, dtsConfigPath, options.checkerName);
  }
}

function addGovernedCheckerMappings(options: {
  generatedGraph: GeneratedTsconfigGraphResult;
  namesByPath: Map<string, string[]>;
}): void {
  for (const [checkerName, governedSources] of options.generatedGraph
    .governedSources) {
    addGovernedCheckerUnitMappings({
      checkerName,
      governedSources,
      namesByPath: options.namesByPath,
    });
  }
}

function addGovernedCheckerUnitMappings(options: {
  checkerName: string;
  governedSources: ReadonlyMap<string, GovernedSourceUnit>;
  namesByPath: Map<string, string[]>;
}): void {
  for (const unit of options.governedSources.values()) {
    addCheckerName(options.namesByPath, unit.configPath, options.checkerName);
    addGovernedProjectionMapping({ ...options, unit });
  }
}

function addGovernedProjectionMapping(options: {
  checkerName: string;
  namesByPath: Map<string, string[]>;
  unit: GovernedSourceUnit;
}): void {
  if (options.unit.buildProjection.kind === 'framework-checker') return;
  addCheckerName(
    options.namesByPath,
    'buildConfigPath' in options.unit.buildProjection
      ? options.unit.buildProjection.buildConfigPath
      : options.unit.buildProjection.dtsConfigPath,
    options.checkerName,
  );
}

function createGeneratedProjectCheckerNamesByPath(
  generatedGraph: GeneratedTsconfigGraphResult,
): Map<string, string[]> {
  const namesByPath = new Map<string, string[]>();
  addGovernedCheckerMappings({ generatedGraph, namesByPath });

  for (const [checkerName, sourceToDts] of generatedGraph.sourceToDts) {
    addCheckerMappings({ checkerName, namesByPath, sourceToDts });
  }

  return namesByPath;
}

async function getCompanionFileNames(options: {
  project: ProjectInfo;
  providers: AnalysisProviderSet;
}): Promise<string[]> {
  const companionPath = options.project.resolverConfigPath;
  if (!existsSync(companionPath)) return [];
  const companion = await options.providers.tsconfig.getProject(
    companionPath,
    options.project,
  );
  return companion.fileNames;
}

async function createSourceProjectEntry(options: {
  checkerNames: readonly string[];
  context?: CheckerProjectParseContext;
  projectPath: string;
  providers: AnalysisProviderSet;
  unit?: GovernedSourceUnit;
  workspaceLookup: WorkspaceLookupIndex;
}): Promise<SourceProjectEntry> {
  const parsed = await options.providers.tsconfig.getProject(
    options.projectPath,
    options.unit?.context ?? options.context,
  );
  const checkerNames = [...options.checkerNames];
  if (options.unit !== undefined) {
    const { context, ownedFileNames } = options.unit;
    const fileNames = ownedFileNames.filter((fileName) =>
      options.workspaceLookup.isInsideActivatedRegion(fileName),
    );
    return {
      checkerNames,
      companionFileNames: ownedFileNames,
      fileNames,
      project: {
        ...parsed,
        checkerPresets: [...context.checkerPresets],
        extensions: [...context.extensions],
        vueSemanticIdentity: context.vueSemanticIdentity,
        fileNames,
        ownedFileNames: fileNames,
      },
    };
  }

  const project = filterProjectInfoToActivatedRegion(
    parsed,
    options.workspaceLookup,
  );
  const companionFileNames = await getCompanionFileNames({
    ...options,
    project,
  });
  return {
    checkerNames,
    companionFileNames,
    fileNames: uniqueSortedStrings(
      [...project.fileNames, ...companionFileNames].filter((fileName) =>
        options.workspaceLookup.isInsideActivatedRegion(fileName),
      ),
    ),
    project,
  };
}

export async function createSourceProjectEntries(options: {
  generatedGraph: GeneratedTsconfigGraphResult;
  projectContextsByPath: ReadonlyMap<string, CheckerProjectParseContext>;
  projectPaths: string[];
  providers: AnalysisProviderSet;
  workspaceLookup: WorkspaceLookupIndex;
}): Promise<SourceProjectEntry[]> {
  const unitByPath = createUnitByProjectPath(options.generatedGraph);
  const checkerNames = createGeneratedProjectCheckerNamesByPath(
    options.generatedGraph,
  );
  return Promise.all(
    options.projectPaths.map((projectPath) =>
      createSourceProjectEntry({
        ...options,
        checkerNames: checkerNames.get(projectPath) ?? [],
        context: options.projectContextsByPath.get(projectPath),
        projectPath,
        unit: unitByPath.get(projectPath),
      }),
    ),
  );
}
