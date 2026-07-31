import type { CheckerProjectParseContext } from '#checkers';
import type { ResolvedLiminaConfig } from '#config/runner';
import type { AnalysisProviderSet } from '#core';
import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
import {
  isDtsProjectConfig,
  type ProjectInfo,
} from '#core/import-graph/context';
import { uniqueCodeUnitSortedStrings as uniqueSortedStrings } from '#utils/collections';
import { existsSync } from 'node:fs';
import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import type { CheckCounter } from '../check-reporting/stats';
import type { WorkspaceLookupIndex } from '../core/workspace/lookup';
import type { AmbientDeclarationIndex } from './ambient-declarations';
import { createSourceDiagnosticFinding } from './finding-utils';
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

export async function collectSourceProjects(options: {
  projectContextsByPath: ReadonlyMap<string, CheckerProjectParseContext>;
  projectPaths: string[];
  providers: AnalysisProviderSet;
  workspaceLookup: WorkspaceLookupIndex;
}): Promise<ProjectInfo[]> {
  const projects = await Promise.all(
    options.projectPaths.map((projectPath) =>
      options.providers.tsconfig.getProject(
        projectPath,
        options.projectContextsByPath.get(projectPath),
      ),
    ),
  );

  return projects.map((project) =>
    filterProjectInfoToActivatedRegion(project, options.workspaceLookup),
  );
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
  for (const [sourceConfigPath, dtsConfigPath] of options.sourceToDts) {
    addCheckerName(options.namesByPath, sourceConfigPath, options.checkerName);
    addCheckerName(options.namesByPath, dtsConfigPath, options.checkerName);
  }
}

export function createGeneratedProjectCheckerNamesByPath(
  generatedGraph: GeneratedTsconfigGraphResult,
): Map<string, string[]> {
  const namesByPath = new Map<string, string[]>();

  for (const [checkerName, sourceToDts] of generatedGraph.sourceToDts) {
    addCheckerMappings({ checkerName, namesByPath, sourceToDts });
  }

  return namesByPath;
}

async function collectSourceProjectFileNames(options: {
  project: ProjectInfo;
  providers: AnalysisProviderSet;
}): Promise<Set<string>> {
  const typecheckConfigPath = options.project.resolverConfigPath;
  if (!existsSync(typecheckConfigPath)) {
    return new Set(options.project.fileNames);
  }

  const companion = await options.providers.tsconfig.getProject(
    typecheckConfigPath,
    options.project,
  );
  return new Set([...options.project.fileNames, ...companion.fileNames]);
}

async function createSourceProjectEntry(options: {
  checkerNamesByPath: ReadonlyMap<string, readonly string[]>;
  project: ProjectInfo;
  providers: AnalysisProviderSet;
  workspaceLookup: WorkspaceLookupIndex;
}): Promise<SourceProjectEntry> {
  const fileNames = await collectSourceProjectFileNames(options);

  return {
    checkerNames: [
      ...(options.checkerNamesByPath.get(options.project.configPath) ?? []),
    ],
    fileNames: [...fileNames]
      .filter((fileName) =>
        options.workspaceLookup.isInsideActivatedRegion(fileName),
      )
      .sort(),
    project: options.project,
  };
}

export async function createSourceProjectEntries(options: {
  checkerNamesByPath: ReadonlyMap<string, readonly string[]>;
  projects: ProjectInfo[];
  providers: AnalysisProviderSet;
  workspaceLookup: WorkspaceLookupIndex;
}): Promise<SourceProjectEntry[]> {
  const dtsProjects = options.projects.filter((project) =>
    isDtsProjectConfig(project.configPath),
  );

  return Promise.all(
    dtsProjects.map((project) =>
      createSourceProjectEntry({ ...options, project }),
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

async function addProjectOwnership(options: {
  ambientDeclarations: AmbientDeclarationIndex;
  checks: CheckCounter;
  config: ResolvedLiminaConfig;
  findings: SourceFinding[];
  project: ProjectInfo;
  providers: AnalysisProviderSet;
  workspaceLookup: WorkspaceLookupIndex;
}): Promise<void> {
  addProjectLabelFinding(options);
  if (!isDtsProjectConfig(options.project.configPath)) {
    return;
  }

  addProjectOwnerProblems({
    ambientDeclarations: options.ambientDeclarations,
    checks: options.checks,
    config: options.config,
    configPath: options.project.configPath,
    fileNames: options.project.fileNames,
    findings: options.findings,
    role: 'declaration leaf',
    workspaceLookup: options.workspaceLookup,
  });

  const typecheckConfigPath = options.project.resolverConfigPath;
  if (!existsSync(typecheckConfigPath)) {
    return;
  }

  const companion = await options.providers.tsconfig.getProject(
    typecheckConfigPath,
    options.project,
  );
  addProjectOwnerProblems({
    ambientDeclarations: options.ambientDeclarations,
    checks: options.checks,
    config: options.config,
    configPath: typecheckConfigPath,
    fileNames: companion.fileNames,
    findings: options.findings,
    role: 'typecheck companion',
    workspaceLookup: options.workspaceLookup,
  });
}

export async function addSourceProjectOwnerProblems(options: {
  ambientDeclarations: AmbientDeclarationIndex;
  checks: CheckCounter;
  config: ResolvedLiminaConfig;
  findings: SourceFinding[];
  providers: AnalysisProviderSet;
  projects: ProjectInfo[];
  workspaceLookup: WorkspaceLookupIndex;
}): Promise<void> {
  for (const project of options.projects) {
    await addProjectOwnership({ ...options, project });
  }
}
