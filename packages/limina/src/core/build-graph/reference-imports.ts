import { toRelativePath } from '#utils/path';
import { shouldInferDeclarationReferenceFromImportRecord } from '../import-graph/declaration-reference-evidence';
import {
  collectProjectDependencies,
  createSourceProjectSemanticContext,
} from '../project-dependencies/runner';
import type {
  ReferenceImportContext,
  ReferenceImportOptions,
} from './reference-import-types';
import { addMappedReference } from './reference-recording';
import {
  addMissingOwnedDeclarationProviderProblem,
  createReferenceTarget,
  isValidReferenceTarget,
  resolveUsableProvider,
} from './reference-target-resolution';
import type { GovernedSourceUnit, SourceProject } from './types';

export type { ReferenceImportContext } from './reference-import-types';

export function processDeclarationProviderImport(
  options: ReferenceImportOptions,
): void {
  const provider = resolveUsableProvider(options);
  const target = createReferenceTarget({ base: options, provider });
  if (isValidReferenceTarget(options.project.configPath, target)) {
    addMappedReference({ base: options, target });
  }
}

function addProjectDependencyFailures(options: {
  context: ReferenceImportContext;
  project: SourceProject;
  source?: GovernedSourceUnit;
}): void {
  const collection = collectProjectDependencies({
    caches: options.context.projectDependencyCaches,
    context: createSourceProjectSemanticContext({
      authority: options.project.semanticAuthority,
      project: options.project,
      source: options.source,
      workspaceSourceBoundary: options.context.workspaceSourceBoundary,
    }),
    importAnalysis: options.context.importAnalysis,
  });
  addDependencyCollectionFailures(options.context, collection.failures);
  processReferenceDependencies(options, collection.dependencies);
  processMissingReferenceObservations(options, collection.observations);
}

function addDependencyCollectionFailures(
  context: ReferenceImportContext,
  failures: ReturnType<typeof collectProjectDependencies>['failures'],
): void {
  for (const failure of failures) {
    context.problems.push(
      [
        'Project dependency collection failed while inferring references:',
        `  config: ${toRelativePath(context.config.rootDir, failure.configPath)}`,
        `  framework: ${failure.framework}`,
        `  stage: ${failure.stage}`,
        `  reason: ${failure.reason}`,
      ].join('\n'),
    );
  }
}

function processReferenceDependencies(
  options: Parameters<typeof addProjectDependencyFailures>[0],
  dependencies: ReturnType<typeof collectProjectDependencies>['dependencies'],
): void {
  for (const dependency of dependencies) {
    processReferenceDependency(options, dependency);
  }
}

function processReferenceDependency(
  options: Parameters<typeof addProjectDependencyFailures>[0],
  dependency: ReturnType<
    typeof collectProjectDependencies
  >['dependencies'][number],
): void {
  if (
    !shouldInferDeclarationReferenceFromImportRecord(dependency.importRecord)
  ) {
    return;
  }
  processDeclarationProviderImport({
    context: options.context,
    fileName: dependency.importRecord.filePath,
    importRecord: dependency.importRecord,
    project: options.project,
    projectDependency: dependency,
  });
}

function processMissingReferenceObservations(
  options: Parameters<typeof addProjectDependencyFailures>[0],
  observations: ReturnType<typeof collectProjectDependencies>['observations'],
): void {
  for (const observation of observations) {
    if (observation.kind !== 'missing') continue;
    addMissingOwnedDeclarationProviderProblem({
      context: options.context,
      fileName: observation.importRecord.filePath,
      importRecord: observation.importRecord,
      project: options.project,
    });
  }
}

export function processProjectReferenceImports(options: {
  context: ReferenceImportContext;
  project: SourceProject;
  source?: GovernedSourceUnit;
}): void {
  addProjectDependencyFailures(options);
}
