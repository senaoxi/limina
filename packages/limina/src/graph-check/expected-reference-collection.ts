import {
  collectImportsFromFile,
  type ImportRecord,
  type ProjectInfo,
} from '#core/import-graph/context';
import { shouldInferDeclarationReferenceFromImportRecord } from '../core/import-graph/declaration-reference-evidence';
import { addDeniedDepImportProblem } from './import-access-denied';
import { resolveImportForReferenceExpectation } from './reference-import-resolution';
import {
  addExpectedReferenceForTarget,
  findExpectedReferenceTargetProjectPath,
} from './reference-target';
import type {
  ExpectedReferenceCollectionContext,
  ExpectedReferenceCollectionOptions,
  ExpectedReferencesByProjectPath,
  GraphImportResolution,
} from './reference-types';
import { getDeniedDepRuleForSpecifier } from './rules';

function createExpectedReferenceCollectionContext(
  options: ExpectedReferenceCollectionOptions,
): ExpectedReferenceCollectionContext {
  return {
    ...options,
    expectedReferencesByProjectPath: new Map(),
  };
}

function isProjectSelected(
  context: ExpectedReferenceCollectionContext,
  project: ProjectInfo,
): boolean {
  const selectedPaths = context.selectedProjectPaths;
  return selectedPaths ? selectedPaths.has(project.configPath) : true;
}

function addRawDeniedImportIfNeeded(options: {
  context: ExpectedReferenceCollectionContext;
  importRecord: ImportRecord;
  project: ProjectInfo;
}): boolean {
  const rule = getDeniedDepRuleForSpecifier(
    options.context.graphRules,
    options.project.labels,
    options.importRecord.specifier,
  );
  if (!rule) {
    return false;
  }

  addDeniedDepImportProblem({
    config: options.context.config,
    findings: options.context.findings,
    importRecord: options.importRecord,
    project: options.project,
    projectCheckerNamesByPath: options.context.projectCheckerNamesByPath,
    rule,
  });
  return true;
}

function createResolvedTarget(options: {
  resolution: GraphImportResolution;
  targetProjectPath: string | null;
}): {
  resolution: GraphImportResolution;
  targetProjectPath: string;
} | null {
  if (!options.targetProjectPath) {
    return null;
  }

  return {
    resolution: options.resolution,
    targetProjectPath: options.targetProjectPath,
  };
}

function resolveExpectedTarget(options: {
  context: ExpectedReferenceCollectionContext;
  filePath: string;
  importRecord: ImportRecord;
  project: ProjectInfo;
}): {
  resolution: GraphImportResolution;
  targetProjectPath: string;
} | null {
  if (!shouldInferDeclarationReferenceFromImportRecord(options.importRecord)) {
    return null;
  }

  const resolution = resolveImportForReferenceExpectation(options);
  if (!resolution) {
    return null;
  }

  return createResolvedTarget({
    resolution,
    targetProjectPath: findExpectedReferenceTargetProjectPath({
      context: options.context,
      importRecord: options.importRecord,
      project: options.project,
      resolution,
    }),
  });
}

function collectExpectedReferenceForImport(options: {
  context: ExpectedReferenceCollectionContext;
  filePath: string;
  importRecord: ImportRecord;
  project: ProjectInfo;
}): void {
  if (addRawDeniedImportIfNeeded(options)) {
    return;
  }

  const target = resolveExpectedTarget(options);
  if (!target) {
    return;
  }

  addExpectedReferenceForTarget({
    context: options.context,
    importRecord: options.importRecord,
    project: options.project,
    resolution: target.resolution,
    targetProjectPath: target.targetProjectPath,
  });
}

function collectExpectedReferencesForFile(options: {
  context: ExpectedReferenceCollectionContext;
  filePath: string;
  project: ProjectInfo;
}): void {
  const imports = collectImportsFromFile(
    options.filePath,
    options.context.config.rootDir,
    options.context.importAnalysis,
  );

  for (const importRecord of imports) {
    collectExpectedReferenceForImport({ ...options, importRecord });
  }
}

function collectExpectedReferencesForProject(
  context: ExpectedReferenceCollectionContext,
  project: ProjectInfo,
): void {
  if (!isProjectSelected(context, project)) {
    return;
  }

  for (const filePath of project.ownedFileNames) {
    collectExpectedReferencesForFile({ context, filePath, project });
  }
}

export function collectExpectedReferences(
  options: ExpectedReferenceCollectionOptions,
): ExpectedReferencesByProjectPath {
  const context = createExpectedReferenceCollectionContext(options);

  for (const project of context.projects) {
    collectExpectedReferencesForProject(context, project);
  }

  return context.expectedReferencesByProjectPath;
}
