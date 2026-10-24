import { toRelativePath } from '#utils/path';
import { shouldInferDeclarationReferenceFromImportRecord } from '../import-graph/declaration-reference-evidence';
import { effectiveReferenceInputs } from '../project-dependencies/declaration-projection';
import {
  collectProjectDependencies,
  createSourceProjectSemanticContext,
} from '../project-dependencies/runner';
import { retainDependencyFailure } from './analysis-failure';
import { collectDeclarationContextDecisions } from './declaration-context-decisions';
import { addDeclarationContextReferences } from './declaration-context-references';
import { retainNativeAnalysis } from './native-analysis-evidence';
import { recordNativeGovernanceProblems } from './native-governance';
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
  if (options.projectDependency.referenceRequirement === null) return;
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
    compilationObligationScope: 'generated-declaration-project-v1',
    caches: options.context.projectDependencyCaches,
    context: createSourceProjectSemanticContext({
      authority: options.project.semanticAuthority,
      project: options.project,
      source: options.source,
      workspaceSourceBoundary: options.context.workspaceSourceBoundary,
    }),
    importAnalysis: options.context.importAnalysis,
  });
  retainNativeAnalysis(options.context.analysis, collection.nativeEvidence);
  recordCollectionGovernance(options, collection.dependencies);
  addDependencyCollectionFailures(options.context, collection.failures);
  const declaration = collectDeclarationContextDecisions({
    config: options.context.config,
    project: options.project,
    snapshot: collection.nativeEvidence,
    unsupportedDependencies:
      options.project.semanticAuthority.family === 'typescript'
        ? undefined
        : collection.dependencies,
    coverageIndex: options.context.projectDependencyCaches.sourceConfigCoverage,
    isWorkspaceFile:
      options.context.workspaceSourceBoundary.governance?.isWorkspaceFile,
  });
  options.context.problems.push(...declaration.problems);
  if (options.context.analysis)
    (options.context.analysis.declarationContexts ??= []).push(
      ...declaration.decisions,
    );
  const collect = () => {
    processReferenceDependencies(options, effectiveReferenceInputs(collection));
    addDeclarationContextReferences({
      ...options,
      decisions: declaration.decisions,
      snapshot: collection.nativeEvidence,
    });
  };
  const cache = options.context.projectDependencyCaches.analysisCache;
  if (cache === undefined) collect();
  else
    cache.contributions.replaceProject({
      config: options.project.configPath,
      checker: options.project.checkerName,
      collect,
      complete: collection.failures.length === 0,
    });
  processMissingReferenceObservations(options, collection);
}

function recordCollectionGovernance(
  options: Parameters<typeof addProjectDependencyFailures>[0],
  dependencies: ReturnType<typeof collectProjectDependencies>['dependencies'],
): void {
  for (const dependency of dependencies)
    recordNativeGovernanceProblems({
      context: options.context,
      fileName: dependency.importRecord.filePath,
      importRecord: dependency.importRecord,
      project: options.project,
      projectDependency: dependency,
    });
}

function addDependencyCollectionFailures(
  context: ReferenceImportContext,
  failures: ReturnType<typeof collectProjectDependencies>['failures'],
): void {
  if (failures.length > 0) markAnalysisIncomplete(context);
  for (const failure of failures) {
    retainDependencyCollectionFailure(context, failure);
  }
}

function retainDependencyCollectionFailure(
  context: ReferenceImportContext,
  failure: ReturnType<typeof collectProjectDependencies>['failures'][number],
): void {
  const detail = [
    'Project dependency collection failed while inferring references:',
    `  config: ${toRelativePath(context.config.rootDir, failure.configPath)}`,
    `  framework: ${failure.framework}`,
    `  stage: ${failure.stage}`,
    `  reason: ${failure.reason}`,
  ].join('\n');
  context.analysis?.diagnostics.push(detail);
  retainDependencyFailure(context.projectDependencyCaches, failure, detail);
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
  collection: ReturnType<typeof collectProjectDependencies>,
): void {
  const missing = collection.observations.filter(
    (entry) => entry.kind === 'missing',
  );
  for (const observation of missing) {
    recordMissingObservation(options, observation);
    if (collection.nativeEvidence !== undefined) continue;
    markAnalysisIncomplete(options.context);
    addMissingOwnedDeclarationProviderProblem({
      context: options.context,
      fileName: observation.importRecord.filePath,
      importRecord: observation.importRecord,
      project: options.project,
    });
  }
}

function recordMissingObservation(
  options: Parameters<typeof addProjectDependencyFailures>[0],
  observation: Extract<
    ReturnType<typeof collectProjectDependencies>['observations'][number],
    { kind: 'missing' }
  >,
): void {
  options.context.analysis?.diagnostics.push(
    [
      'Dependency comparison could not resolve an import:',
      `  config: ${toRelativePath(options.context.config.rootDir, options.project.configPath)}`,
      `  file: ${toRelativePath(options.context.config.rootDir, observation.importRecord.filePath)}:${observation.importRecord.line}`,
      `  imported specifier: ${observation.importRecord.specifier}`,
      '  stage: declaration-reference-inference',
    ].join('\n'),
  );
}

export function processProjectReferenceImports(options: {
  context: ReferenceImportContext;
  project: SourceProject;
  source?: GovernedSourceUnit;
}): void {
  addProjectDependencyFailures(options);
}

function markAnalysisIncomplete(context: ReferenceImportContext): void {
  if (context.analysis) context.analysis.complete = false;
}
