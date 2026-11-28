import type { ImportRecord, ProjectInfo } from '#core/import-graph/context';
import { shouldInferDeclarationReferenceFromImportRecord } from '../core/import-graph/declaration-reference-evidence';
import type {
  ProjectDependency,
  ProjectDependencyCollection,
} from '../core/project-dependencies/contracts';
import { effectiveReferenceInputs } from '../core/project-dependencies/declaration-projection';
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

function collectExpectedDependencies(
  context: ExpectedReferenceCollectionContext,
  project: ProjectInfo,
  collection: ProjectDependencyCollection,
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

  for (const {
    declaration,
    project,
    runtime,
  } of context.preparedProjectDependencies) {
    recordRuntimeDependencyGovernance(context, project, runtime);
    collectExpectedDependencies(context, project, declaration);
  }

  return context.expectedReferencesByProjectPath;
}
