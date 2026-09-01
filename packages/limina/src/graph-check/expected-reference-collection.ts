import type { ImportRecord, ProjectInfo } from '#core/import-graph/context';
import { shouldInferDeclarationReferenceFromImportRecord } from '../core/import-graph/declaration-reference-evidence';
import {
  collectProjectDependencies,
  createParsedProjectSemanticContext,
  type ProjectDependency,
  type ProjectDependencyObservation,
} from '../core/project-dependencies/runner';
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
import { addUnresolvedWorkspaceImportProblem } from './workspace-import-findings';

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
  projectDependency?: ProjectDependency;
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
  projectDependency: ProjectDependency;
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
  projectDependency: ProjectDependency;
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

function collectExpectedReferencesForDependency(options: {
  context: ExpectedReferenceCollectionContext;
  project: ProjectInfo;
  projectDependency: ProjectDependency;
}): void {
  collectExpectedReferenceForImport({
    ...options,
    filePath: options.projectDependency.importRecord.filePath,
    importRecord: options.projectDependency.importRecord,
  });
}

function collectExpectedReferencesForObservation(options: {
  context: ExpectedReferenceCollectionContext;
  observation: ProjectDependencyObservation;
  project: ProjectInfo;
}): void {
  const observation = options.observation;
  if (observation.kind === 'unmapped-generated') return;
  collectExpectedReferencesForMappedObservation({
    context: options.context,
    importRecord: observation.importRecord,
    observation,
    project: options.project,
  });
}

function collectExpectedReferencesForMappedObservation(options: {
  context: ExpectedReferenceCollectionContext;
  importRecord: ImportRecord;
  observation: Exclude<
    ProjectDependencyObservation,
    { kind: 'unmapped-generated' }
  >;
  project: ProjectInfo;
}): void {
  const importRecord = options.observation.importRecord;
  if (addRawDeniedImportIfNeeded({ ...options, importRecord })) return;
  addMissingObservationProblem({ ...options, importRecord });
}

function addMissingObservationProblem(options: {
  context: ExpectedReferenceCollectionContext;
  importRecord: ImportRecord;
  observation: Exclude<
    ProjectDependencyObservation,
    { kind: 'unmapped-generated' }
  >;
  project: ProjectInfo;
}): void {
  const importRecord = options.importRecord;
  if (!shouldInferDeclarationReferenceFromImportRecord(importRecord)) return;
  if (options.observation.kind !== 'missing') return;
  addUnresolvedWorkspaceImportProblem({
    ...options,
    importRecord,
    targetPackage: options.context.workspaceLookup.findPackageForSpecifier(
      importRecord.specifier,
    ),
  });
}

function getGraphAuthority(project: ProjectInfo) {
  const authority = project.semanticAuthority;
  if (authority !== undefined) return authority;
  throw new Error(
    `Missing frozen semantic authority for graph-check project ${project.configPath}.`,
  );
}

function getGraphPackageRoot(
  context: ExpectedReferenceCollectionContext,
  project: ProjectInfo,
): string {
  const owner = context.workspaceLookup.findOwnerForFile(project.configPath);
  return owner === null ? context.config.rootDir : owner.directory;
}

function assertGraphCollection(
  collection: ReturnType<typeof collectProjectDependencies>,
): void {
  const failure = collection.failures[0];
  if (failure === undefined) return;
  throw new Error(
    `Graph-check semantic dependency collection failed at ${failure.stage}: ${failure.reason}`,
  );
}

function collectProjectDependenciesForGraph(options: {
  context: ExpectedReferenceCollectionContext;
  project: ProjectInfo;
}) {
  const authority = getGraphAuthority(options.project);
  const packageRootDir = getGraphPackageRoot(options.context, options.project);
  return collectProjectDependencies({
    caches: options.context.projectDependencyCaches,
    context: createParsedProjectSemanticContext({
      authority,
      packageRootDir,
      project: options.project,
      workspaceSourceBoundary: options.context.workspaceSourceBoundary,
    }),
    importAnalysis: options.context.importAnalysis,
    resolveWorkspaceTypeScriptExport: (specifier) =>
      options.context.workspaceExports.get(
        options.project.configPath,
        specifier,
      )?.typeScriptResolvedFileName ?? null,
  });
}

function collectExpectedReferencesForProject(
  context: ExpectedReferenceCollectionContext,
  project: ProjectInfo,
): void {
  if (!isProjectSelected(context, project)) return;
  const collection = collectProjectDependenciesForGraph({ context, project });
  assertGraphCollection(collection);
  collectExpectedDependencies(context, project, collection.dependencies);
  collectExpectedObservations(context, project, collection.observations);
}

function collectExpectedDependencies(
  context: ExpectedReferenceCollectionContext,
  project: ProjectInfo,
  dependencies: readonly ProjectDependency[],
): void {
  for (const projectDependency of dependencies) {
    collectExpectedReferencesForDependency({
      context,
      project,
      projectDependency,
    });
  }
}

function collectExpectedObservations(
  context: ExpectedReferenceCollectionContext,
  project: ProjectInfo,
  observations: readonly ProjectDependencyObservation[],
): void {
  for (const observation of observations) {
    collectExpectedReferencesForObservation({
      context,
      observation,
      project,
    });
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
