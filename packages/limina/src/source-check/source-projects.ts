import type { CheckerProjectParseContext } from '#checkers';
import type { ResolvedLiminaConfig } from '#config/runner';
import type { AnalysisProviderSet } from '#core';
import type {
  GeneratedTsconfigGraphResult,
  GovernedSourceUnit,
} from '#core/build-graph/runner';
import {
  isDtsProjectConfig,
  type ProjectInfo,
} from '#core/import-graph/context';
import { uniqueCodeUnitSortedStrings as uniqueSortedStrings } from '#utils/collections';
import { existsSync } from 'node:fs';
import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import type { CheckCounter } from '../check-reporting/stats';
import { createUnitByProjectPath } from '../core/project-dependencies/project-alignment';
import type { WorkspaceLookupIndex } from '../core/workspace/lookup';
import type { AmbientDeclarationIndex } from './ambient-declarations';
import { createSourceDiagnosticFinding } from './finding-utilities';
import type { SourceFinding } from './findings';
import { addProjectOwnerProblems } from './project-owner-findings';
import type { SourceProjectEntry } from './source-types';

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

function addProjectLabelFinding(options: {
  findings: SourceFinding[];
  project: ProjectInfo;
}): void {
  const diagnostic = options.project.labelDiagnostic;
  if (!diagnostic) {
    return;
  }

  options.findings.push(
    createSourceDiagnosticFinding({
      code: LIMINA_CHECK_ISSUE_CODES.sourceTsconfigGovernance,
      facts: {
        configPath: diagnostic.projectPath,
        field: diagnostic.field,
        kind: 'project-label',
        value: diagnostic.value,
      },
      filePath: diagnostic.projectPath,
      lines: diagnostic.detailLines,
      locations: [
        { filePath: diagnostic.projectPath, label: 'project' },
        { label: 'field', scope: diagnostic.field },
      ],
      reason: diagnostic.reason,
      scope: diagnostic.field,
      title: diagnostic.title,
    }),
  );
}

interface ProjectOwnershipOptions {
  ambientDeclarations: AmbientDeclarationIndex;
  checks: CheckCounter;
  config: ResolvedLiminaConfig;
  findings: SourceFinding[];
  companionFileNames: string[];
  project: ProjectInfo;
  workspaceLookup: WorkspaceLookupIndex;
}

function getProjectOwnershipRole(
  isDtsProject: boolean,
): 'declaration leaf' | 'governed source' {
  return isDtsProject ? 'declaration leaf' : 'governed source';
}

function addCompanionProjectOwnership(
  options: ProjectOwnershipOptions,
  isDtsProject: boolean,
): void {
  if (!isDtsProject) return;
  const typecheckConfigPath = options.project.resolverConfigPath;
  if (!existsSync(typecheckConfigPath)) return;
  addProjectOwnerProblems({
    ambientDeclarations: options.ambientDeclarations,
    checks: options.checks,
    config: options.config,
    configPath: typecheckConfigPath,
    fileNames: options.companionFileNames,
    findings: options.findings,
    role: 'typecheck companion',
    workspaceLookup: options.workspaceLookup,
  });
}

function addProjectOwnership(options: ProjectOwnershipOptions): void {
  addProjectLabelFinding(options);
  const isDtsProject = isDtsProjectConfig(options.project.configPath);
  addProjectOwnerProblems({
    ambientDeclarations: options.ambientDeclarations,
    checks: options.checks,
    config: options.config,
    configPath: options.project.configPath,
    fileNames: options.project.fileNames,
    findings: options.findings,
    role: getProjectOwnershipRole(isDtsProject),
    workspaceLookup: options.workspaceLookup,
  });
  addCompanionProjectOwnership(options, isDtsProject);
}

export function addSourceProjectOwnerProblems(options: {
  ambientDeclarations: AmbientDeclarationIndex;
  checks: CheckCounter;
  config: ResolvedLiminaConfig;
  findings: SourceFinding[];
  sourceProjectEntries: SourceProjectEntry[];
  workspaceLookup: WorkspaceLookupIndex;
}): void {
  for (const { project, companionFileNames } of options.sourceProjectEntries) {
    addProjectOwnership({ ...options, project, companionFileNames });
  }
}
