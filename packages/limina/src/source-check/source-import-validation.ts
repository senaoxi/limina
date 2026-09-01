import type { ResolvedLiminaConfig } from '#config/runner';
import type { AnalysisProviderSet } from '#core';
import type { ImportRecord, ProjectInfo } from '#core/import-graph/context';
import type { PackageOwner, WorkspacePackage } from '#core/workspace/actions';
import type { CheckCounter } from '../check-reporting/stats';
import {
  collectProjectDependencies,
  createParsedProjectSemanticContext,
  type ProjectDependencyCaches,
} from '../core/project-dependencies/runner';
import {
  createWorkspaceSourceBoundary,
  type WorkspaceSourceBoundary,
} from '../core/typescript-semantic';
import type { WorkspaceLookupIndex } from '../core/workspace/lookup';
import type { WorkspaceRegionPathIndex } from '../core/workspace/validated-context';
import type { AmbientDeclarationIndex } from './ambient-declarations';
import type { SourceFinding } from './findings';
import { addImportRecordProblems } from './import-record-validation';
import { addResourceModuleProblems } from './resource-module-findings';
import type {
  CompiledImportAuthorityAllowRule,
  SourceProjectEntry,
} from './source-types';

interface SourceImportOptions {
  ambientDeclarations: AmbientDeclarationIndex;
  checks: CheckCounter;
  config: ResolvedLiminaConfig;
  importAnalysis: AnalysisProviderSet['imports']['context'];
  importAuthorityAllowRules: CompiledImportAuthorityAllowRule[];
  packages: WorkspacePackage[];
  pathIndex: WorkspaceRegionPathIndex;
  projectDependencyCaches: ProjectDependencyCaches;
  findings: SourceFinding[];
  rootPackage: WorkspacePackage | null;
  typeEvidence: AnalysisProviderSet['typeEvidence'];
  workspaceLookup: WorkspaceLookupIndex;
  workspaceSourceBoundary: WorkspaceSourceBoundary;
}

function getSourceAuthority(entry: SourceProjectEntry) {
  const authority = entry.project.semanticAuthority;
  if (authority !== undefined) return authority;
  throw new Error(
    `Missing frozen semantic authority for source-check project ${entry.project.configPath}.`,
  );
}

function getSourcePackageRoot(
  base: SourceImportOptions,
  entry: SourceProjectEntry,
): string {
  return getSourceOwner(base, entry)?.directory ?? base.config.rootDir;
}

function getSourceOwner(
  base: SourceImportOptions,
  entry: SourceProjectEntry,
): WorkspacePackage | null {
  const projectOwner = base.workspaceLookup.findOwnerForFile(
    entry.project.configPath,
  );
  if (projectOwner !== null) return projectOwner;
  const firstFileName = entry.fileNames[0];
  if (firstFileName === undefined) return null;
  return base.workspaceLookup.findOwnerForFile(firstFileName);
}

function assertSourceCollection(
  collection: ReturnType<typeof collectProjectDependencies>,
): void {
  const failure = collection.failures[0];
  if (failure === undefined) return;
  throw new Error(
    `Source-check semantic dependency collection failed at ${failure.stage}: ${failure.reason}`,
  );
}

function addResourceProblemsForCheckers(options: {
  base: SourceImportOptions;
  checkerNames: string[];
  importRecord: ImportRecord;
  owner: PackageOwner;
  project: ProjectInfo;
}): void {
  for (const checkerName of options.checkerNames) {
    addResourceModuleProblems({
      checkerName,
      config: options.base.config,
      findings: options.base.findings,
      importRecord: options.importRecord,
      owner: options.owner,
      project: options.project,
      typeEvidence: options.base.typeEvidence,
    });
  }
}

function processImportRecord(options: {
  base: SourceImportOptions;
  checkerNames: string[];
  filePath: string;
  importRecord: ImportRecord;
  owner: PackageOwner;
  project: ProjectInfo;
  resolvedFilePath: string | null;
}): void {
  options.base.checks.add();
  addResourceProblemsForCheckers(options);
  addImportRecordProblems({
    ambientDeclarations: options.base.ambientDeclarations,
    config: options.base.config,
    filePath: options.filePath,
    importAuthorityAllowRules: options.base.importAuthorityAllowRules,
    importRecord: options.importRecord,
    owner: options.owner,
    packages: options.base.packages,
    pathIndex: options.base.pathIndex,
    findings: options.base.findings,
    project: options.project,
    resolvedFilePath: options.resolvedFilePath,
    rootPackage: options.base.rootPackage,
    workspaceLookup: options.base.workspaceLookup,
  });
}

function processSourceProject(
  base: SourceImportOptions,
  entry: SourceProjectEntry,
): void {
  const authority = getSourceAuthority(entry);
  const packageRootDir = getSourcePackageRoot(base, entry);
  const project = {
    ...entry.project,
    fileNames: [...entry.fileNames],
    ownedFileNames: [...entry.fileNames],
  };
  const collection = collectProjectDependencies({
    caches: base.projectDependencyCaches,
    context: createParsedProjectSemanticContext({
      authority,
      packageRootDir,
      project,
      workspaceSourceBoundary: base.workspaceSourceBoundary,
    }),
    importAnalysis: base.importAnalysis,
  });
  assertSourceCollection(collection);
  processSourceDependencies({ base, collection, entry, project });
  processSourceObservations({ base, collection, entry, project });

  base.typeEvidence.completeProject(entry.project.configPath);
}

function processSourceDependencies(options: {
  base: SourceImportOptions;
  collection: ReturnType<typeof collectProjectDependencies>;
  entry: SourceProjectEntry;
  project: ProjectInfo;
}): void {
  for (const dependency of options.collection.dependencies) {
    processCollectedImport({
      base: options.base,
      checkerNames: options.entry.checkerNames,
      importRecord: dependency.importRecord,
      project: options.project,
      resolvedFilePath: dependency.resolvedFilePath,
    });
  }
}

function processSourceObservations(options: {
  base: SourceImportOptions;
  collection: ReturnType<typeof collectProjectDependencies>;
  entry: SourceProjectEntry;
  project: ProjectInfo;
}): void {
  for (const observation of options.collection.observations) {
    processSourceObservation({ ...options, observation });
  }
}

function processSourceObservation(options: {
  base: SourceImportOptions;
  entry: SourceProjectEntry;
  observation: ReturnType<
    typeof collectProjectDependencies
  >['observations'][number];
  project: ProjectInfo;
}): void {
  if (options.observation.kind === 'unmapped-generated') return;
  processCollectedImport({
    base: options.base,
    checkerNames: options.entry.checkerNames,
    importRecord: options.observation.importRecord,
    project: options.project,
    resolvedFilePath: null,
  });
}

function processCollectedImport(options: {
  base: SourceImportOptions;
  checkerNames: string[];
  importRecord: ImportRecord;
  project: ProjectInfo;
  resolvedFilePath: string | null;
}): void {
  const filePath = options.importRecord.filePath;
  const owner = options.base.workspaceLookup.findOwnerForFile(filePath);
  if (owner === null) return;
  processImportRecord({ ...options, filePath, owner });
}

export function addSourceImportProblems(
  options: Omit<SourceImportOptions, 'workspaceSourceBoundary'> & {
    sourceProjectEntries: SourceProjectEntry[];
  },
): void {
  const base: SourceImportOptions = {
    ...options,
    workspaceSourceBoundary: createWorkspaceSourceBoundary(
      options.sourceProjectEntries.flatMap((entry) => entry.fileNames),
    ),
  };
  for (const entry of options.sourceProjectEntries) {
    processSourceProject(base, entry);
  }
}
