import type { ImportRecord, ProjectInfo } from '#core/import-graph/context';
import { shouldInferDeclarationReferenceFromImportRecord } from '../core/import-graph/declaration-reference-evidence';
import { effectiveReferenceInputs } from '../core/project-dependencies/declaration-projection';
import {
  collectProjectDependencies,
  collectRuntimeProjectDependencies,
  createParsedProjectSemanticContext,
  type ProjectDependency,
} from '../core/project-dependencies/runner';
import { createImportRecordIdentity } from '../core/typescript-semantic/import-record';
import { qualifiedNativeDependencyTarget } from '../core/typescript-semantic/native-fact-qualification';
import { getPreferredGeneratedTargetProjectPath } from './generated-project-paths';
import { recordNativeCoverageGovernance } from './native-coverage-governance';
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
import { recordRuntimeDependencyGovernance } from './runtime-dependency-governance';

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
  return !selectedPaths || selectedPaths.has(project.configPath);
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
    targetProjectPath: referenceTarget(options, resolution),
  });
}

function referenceTarget(
  options: Parameters<typeof resolveExpectedTarget>[0],
  resolution: GraphImportResolution,
): string | null {
  const native = nativeEvidence(options.projectDependency);
  if (native === undefined)
    return findExpectedReferenceTargetProjectPath({
      context: options.context,
      importRecord: options.importRecord,
      project: options.project,
      resolution,
    });
  const target = qualifiedNativeDependencyTarget(native);
  return target === null ? null : mappedNativeTarget(options, target);
}

function mappedNativeTarget(
  options: Parameters<typeof resolveExpectedTarget>[0],
  target: string,
): string {
  return getPreferredGeneratedTargetProjectPath({
    generatedGraph: options.context.generatedGraph,
    importingProjectPath: options.project.configPath,
    targetProjectPath: projectedNativeTarget(options.context, target),
  });
}

function nativeEvidence(dependency: ProjectDependency) {
  return dependency.nativeFact?.nativeEvidence;
}

function projectedNativeTarget(
  context: ExpectedReferenceCollectionContext,
  target: string,
): string {
  const graph = context.generatedGraph;
  const owner = graph.ownershipPlan.typeConfigs.get(target)?.finalOwner;
  return owner === undefined
    ? parsedNativeTarget(context.projects, target)
    : generatedNativeTarget(graph.sourceToDts.get(owner), target);
}

function parsedNativeTarget(
  projects: readonly ProjectInfo[],
  target: string,
): string {
  const candidates = projects.filter(
    (project) => project.resolverConfigPath === target,
  );
  return candidates.length === 1 ? candidates[0]!.configPath : target;
}

function generatedNativeTarget(
  mapping: ReadonlyMap<string, string> | undefined,
  target: string,
): string {
  return mapping?.get(target) ?? target;
}

function collectResolvedExpectedReference(options: {
  context: ExpectedReferenceCollectionContext;
  filePath: string;
  importRecord: ImportRecord;
  project: ProjectInfo;
  projectDependency: ProjectDependency;
}): void {
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

function graphDependencyRequest(options: {
  context: ExpectedReferenceCollectionContext;
  project: ProjectInfo;
}) {
  const authority = getGraphAuthority(options.project);
  const packageRootDirectory = getGraphPackageRoot(
    options.context,
    options.project,
  );
  return {
    caches: options.context.projectDependencyCaches,
    managedOutputLookup: options.context.managedOutputLookup,
    context: createParsedProjectSemanticContext({
      authority,
      packageRootDir: packageRootDirectory,
      project: options.project,
      workspaceSourceBoundary: options.context.workspaceSourceBoundary,
    }),
    importAnalysis: options.context.importAnalysis,
  };
}

function collectExpectedReferencesForProject(
  context: ExpectedReferenceCollectionContext,
  project: ProjectInfo,
): void {
  if (!isProjectSelected(context, project)) return;
  const request = graphDependencyRequest({ context, project });
  const runtime = collectRuntimeProjectDependencies(request);
  assertGraphCollection(runtime);
  recordRuntimeDependencyGovernance(context, project, runtime);
  const collection = collectProjectDependencies({
    ...request,
    compilationObligationScope: 'generated-declaration-project-v1',
  });
  assertGraphCollection(collection);
  collectExpectedDependencies(context, project, collection);
}

function collectExpectedDependencies(
  context: ExpectedReferenceCollectionContext,
  project: ProjectInfo,
  collection: ReturnType<typeof collectProjectDependencies>,
): void {
  const eligible = new Set(
    effectiveReferenceInputs(collection).map((dependency) =>
      createImportRecordIdentity(dependency.importRecord),
    ),
  );
  for (const projectDependency of collection.dependencies) {
    recordNativeCoverageGovernance({
      context,
      project,
      filePath: projectDependency.importRecord.filePath,
      importRecord: projectDependency.importRecord,
      projectDependency,
    });
    collectResolvedExpectedReference({
      context,
      project,
      filePath: projectDependency.importRecord.filePath,
      importRecord: projectDependency.importRecord,
      projectDependency: eligible.has(
        createImportRecordIdentity(projectDependency.importRecord),
      )
        ? projectDependency
        : { ...projectDependency, referenceRequirement: null },
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
