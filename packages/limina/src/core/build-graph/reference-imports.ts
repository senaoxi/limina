import { toRelativePath } from '#utils/path';
import { currentProfile } from '../../application/analysis/observability';
import { observeWork } from '../analysis-profile';
import { shouldInferDeclarationReferenceFromImportRecord } from '../import-graph/declaration-reference-evidence';
import {
  readReferenceGraphFacts,
  type ReferenceGraphFacts,
} from '../project-dependencies/reference-facts';
import { createSourceProjectSemanticContext } from '../project-dependencies/runner';
import { retainDependencyFailure } from './analysis-failure';
import {
  collectDeclarationContextDecisions,
  type DeclarationContextProjection,
} from './declaration-context-decisions';
import { addDeclarationContextReferences } from './declaration-context-references';
import { retainNativeAnalysis } from './native-analysis-evidence';
import { recordRequestGovernanceProblems } from './native-governance';
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
import { collectSupplementalReferenceInputs } from './supplemental-reference-inputs';
import type { GovernedSourceUnit, SourceProject } from './types';

export type { ReferenceImportContext } from './reference-import-types';

export function processDeclarationProviderImport(
  options: ReferenceImportOptions,
): void {
  if (options.projectDependency.referenceRequirement === null) return;
  const requiredFile =
    options.projectDependency.referenceRequirement.targetFileName;
  if (
    options.context.activatedRegions.isInsideActivatedRegion(requiredFile) &&
    !options.context.fileOwnerLookup.get(requiredFile)?.length
  ) {
    options.context.problems.push(
      `Unproved necessary compilation relation: ${requiredFile}; no compiler input owner for ${options.project.configPath}.`,
    );
    return;
  }
  const provider = resolveUsableProvider(options);
  const target = createReferenceTarget({ base: options, provider });
  if (isValidReferenceTarget(options.project.configPath, target)) {
    addMappedReference({ base: options, target });
  }
}

export function referenceDeclarationScope(
  context: ReferenceImportContext,
  project: SourceProject,
  collection: ReferenceGraphFacts,
): DeclarationContextProjection {
  return collectDeclarationContextDecisions({
    policy: context.projectDependencyCaches.declarationContextPolicy,
    project,
    evidence: collection.declarationEvidence,
    allowUnqualifiedLocal: !['typescript', 'vue'].includes(
      project.semanticAuthority.family,
    ),
    unsupportedDependencies:
      project.semanticAuthority.family === 'typescript'
        ? undefined
        : collection.dependencies,
    coverageIndex: context.projectDependencyCaches.sourceConfigCoverage,
    isWorkspaceFile:
      context.workspaceSourceBoundary.governance?.isWorkspaceFile,
  });
}

function addProjectDependencyFailures(options: {
  context: ReferenceImportContext;
  project: SourceProject;
  source?: GovernedSourceUnit;
}): void {
  const collection = readReferenceGraphFacts({
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
  if (options.context.analysis && collection.declarationEvidence)
    (options.context.analysis.declarationEvidence ??= []).push(
      collection.declarationEvidence,
    );
  const declaration = referenceDeclarationScope(
    options.context,
    options.project,
    collection,
  );
  const isActiveSource = (entry: { importRecord: { filePath: string } }) =>
    declaration.isActiveSource(entry.importRecord.filePath);
  recordCollectionGovernance(
    options,
    collection.dependencies.filter(isActiveSource),
  );
  addDependencyCollectionFailures(
    options.context,
    collection.failures.filter(
      (failure) =>
        !failure.importRecord ||
        isActiveSource({ importRecord: failure.importRecord }),
    ),
  );
  options.context.problems.push(...declaration.problems);
  const analysis = options.context.analysis;
  if (analysis) {
    analysis.diagnostics.push(...declaration.diagnostics);
    if (
      declaration.decisions.some(
        (decision) => !('config' in decision.selection),
      )
    )
      analysis.complete = false;
    if (declaration.inactiveRequests.size > 0)
      (analysis.inactiveDeclarationRequests ??= []).push(
        ...declaration.inactiveRequests,
      );
  }
  if (options.context.analysis)
    (options.context.analysis.declarationContexts ??= []).push(
      ...declaration.decisions,
    );
  retainNativeAnalysis(options.context.analysis, collection.nativeEvidence);
  const dependencies = collection.referenceInputs.filter(isActiveSource);
  processReferenceDependencies(options, dependencies);
  processReferenceDependencies(
    options,
    collectSupplementalReferenceInputs({ ...options, dependencies }).filter(
      isActiveSource,
    ),
  );
  addDeclarationContextReferences({
    ...options,
    decisions: declaration.decisions,
    evidence: collection.declarationEvidence,
  });
  processMissingReferenceObservations(
    options,
    collection,
    declaration.isActiveSource,
  );
}

function recordCollectionGovernance(
  options: Parameters<typeof addProjectDependencyFailures>[0],
  dependencies: ReferenceGraphFacts['dependencies'],
): void {
  for (const dependency of dependencies)
    recordRequestGovernanceProblems({
      context: options.context,
      fileName: dependency.importRecord.filePath,
      importRecord: dependency.importRecord,
      project: options.project,
      projectDependency: dependency,
    });
}

function addDependencyCollectionFailures(
  context: ReferenceImportContext,
  failures: ReferenceGraphFacts['failures'],
): void {
  if (failures.length > 0) markAnalysisIncomplete(context);
  for (const failure of failures) {
    retainDependencyCollectionFailure(context, failure);
  }
}

function retainDependencyCollectionFailure(
  context: ReferenceImportContext,
  failure: ReferenceGraphFacts['failures'][number],
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
  dependencies: ReferenceGraphFacts['dependencies'],
): void {
  for (const dependency of dependencies) {
    processReferenceDependency(options, dependency);
  }
}

function processReferenceDependency(
  options: Parameters<typeof addProjectDependencyFailures>[0],
  dependency: ReferenceGraphFacts['dependencies'][number],
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
  collection: ReferenceGraphFacts,
  isActiveSource: (file: string) => boolean,
): void {
  const missing = collection.observations.filter(
    (entry) => entry.kind === 'missing',
  );
  for (const observation of missing) {
    if (!isActiveSource(observation.importRecord.filePath)) continue;
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
    ReferenceGraphFacts['observations'][number],
    { kind: 'missing' }
  >,
): void {
  if (options.context.analysis)
    (options.context.analysis.unresolvedDependencies ??= []).push({
      sourceConfig: options.project.configPath,
      file: observation.importRecord.filePath,
      line: observation.importRecord.line,
      specifier: observation.importRecord.specifier,
    });
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
  const observer = currentProfile();
  if (observer === undefined) {
    addProjectDependencyFailures(options);
    return;
  }
  const project = observer.project(options.project.configPath);
  observeWork(
    observer,
    'reference-analysis',
    () => addProjectDependencyFailures(options),
    ['project', project],
  );
}

function markAnalysisIncomplete(context: ReferenceImportContext): void {
  if (context.analysis) context.analysis.complete = false;
}
