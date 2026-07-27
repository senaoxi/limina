import type { ResolvedLiminaConfig } from '#config/runner';
import type { AnalysisProviderSet } from '#core';
import {
  collectImportsFromFile,
  type ImportRecord,
  type ProjectInfo,
} from '#core/import-graph/context';
import type { PackageOwner, WorkspacePackage } from '#core/workspace/actions';
import type { CheckCounter } from '../check-reporting/stats';
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
  findings: SourceFinding[];
  rootPackage: WorkspacePackage | null;
  typeEvidence: AnalysisProviderSet['typeEvidence'];
  workspaceLookup: WorkspaceLookupIndex;
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
}): void {
  options.base.checks.add();
  addResourceProblemsForCheckers(options);
  addImportRecordProblems({
    ambientDeclarations: options.base.ambientDeclarations,
    config: options.base.config,
    filePath: options.filePath,
    importAnalysis: options.base.importAnalysis,
    importAuthorityAllowRules: options.base.importAuthorityAllowRules,
    importRecord: options.importRecord,
    owner: options.owner,
    packages: options.base.packages,
    pathIndex: options.base.pathIndex,
    findings: options.base.findings,
    project: options.project,
    rootPackage: options.base.rootPackage,
    workspaceLookup: options.base.workspaceLookup,
  });
}

function processSourceFile(options: {
  base: SourceImportOptions;
  checkerNames: string[];
  filePath: string;
  project: ProjectInfo;
}): void {
  const owner = options.base.workspaceLookup.findOwnerForFile(options.filePath);
  if (!owner) {
    return;
  }

  const imports = collectImportsFromFile(
    options.filePath,
    options.base.config.rootDir,
    options.base.importAnalysis,
  );
  for (const importRecord of imports) {
    processImportRecord({ ...options, importRecord, owner });
  }
}

function processSourceProject(
  base: SourceImportOptions,
  entry: SourceProjectEntry,
): void {
  for (const filePath of entry.fileNames) {
    processSourceFile({
      base,
      checkerNames: entry.checkerNames,
      filePath,
      project: entry.project,
    });
  }

  base.typeEvidence.completeProject(entry.project.configPath);
}

export function addSourceImportProblems(
  options: SourceImportOptions & {
    sourceProjectEntries: SourceProjectEntry[];
  },
): void {
  for (const entry of options.sourceProjectEntries) {
    processSourceProject(options, entry);
  }
}
