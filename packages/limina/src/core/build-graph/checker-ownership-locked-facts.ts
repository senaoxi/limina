import type { ResolvedLiminaInputs } from '#config/runner';
import { toRelativePath } from '#utils/path';
import type { DeclarationContextDecision } from '../../domain/analysis/declaration-context';
import type { ImportAnalysisContext } from '../import-analysis/runner';
import { shouldInferDeclarationReferenceFromImportRecord } from '../import-graph/declaration-reference-evidence';
import {
  readReferenceGraphFacts,
  type ReferenceDependency,
} from '../project-dependencies/reference-facts';
import {
  createAutoProjectSemanticContext,
  type createProjectDependencyCaches,
  type ProjectDependencyFailure,
} from '../project-dependencies/runner';
import type { WorkspaceSourceBoundary } from '../typescript-semantic';
import { retainDependencyFailure } from './analysis-failure';
import type { AutoScopeProject } from './auto-checker-types';
import type { CheckerOwnershipDiscovery } from './checker-ownership-discovery';
import type {
  CheckerDependencyFact,
  TypeConfigOwnershipState,
} from './checker-ownership-types';
import { coreCollectionRun } from './core-collection-run';
import { collectDeclarationContextDecisions } from './declaration-context-decisions';
import { assessMissingNativeImports } from './locked-supplemental-assessment';

function formatProjectDependencyFailure(options: {
  config: ResolvedLiminaInputs;
  failure: ProjectDependencyFailure;
}): string {
  return [
    'Checker semantic dependency collection failed:',
    `  config: ${toRelativePath(options.config.rootDir, options.failure.configPath)}`,
    `  framework: ${options.failure.framework}`,
    `  stage: ${options.failure.stage}`,
    ...(options.failure.importRecord === undefined
      ? []
      : [
          `  file: ${toRelativePath(options.config.rootDir, options.failure.importRecord.filePath)}:${options.failure.importRecord.line}`,
          `  imported specifier: ${options.failure.importRecord.specifier}`,
        ]),
    `  reason: ${options.failure.reason}`,
  ].join('\n');
}

function createLockedDependencyFact(
  project: AutoScopeProject,
  dependency: ReferenceDependency,
): CheckerDependencyFact {
  const nativeEvidence = dependency.nativeFact?.nativeEvidence;
  if (dependency.referenceRequirement !== null) {
    return {
      nativeEvidence,
      consumerConfigPath: project.configPath,
      importRecord: dependency.importRecord,
      physicalTargetPath: dependency.referenceRequirement.targetFileName,
      physicalTargetProvenance: 'checker-source',
      typeEvidenceKind: getSupportedEvidenceKind(dependency),
      referenceRequirement: dependency.referenceRequirement,
    };
  }
  return {
    nativeEvidence,
    consumerConfigPath: project.configPath,
    importRecord: dependency.importRecord,
    physicalTargetPath: null,
    physicalTargetProvenance: null,
    typeEvidenceKind: getSupportedEvidenceKind(dependency),
    referenceRequirement: dependency.referenceRequirement,
  };
}

export function collectLockedProjectFacts(options: {
  discovery: CheckerOwnershipDiscovery;
  caches: ReturnType<typeof createProjectDependencyCaches>;
  config: ResolvedLiminaInputs;
  importAnalysis: ImportAnalysisContext;
  project: AutoScopeProject;
  state: TypeConfigOwnershipState & {
    semanticAuthority: Extract<
      TypeConfigOwnershipState['semanticAuthority'],
      { kind: 'locked' }
    >;
  };
  workspaceSourceBoundary: WorkspaceSourceBoundary;
}): {
  facts: CheckerDependencyFact[];
  problems: string[];
  failures: string[];
  declarationContexts: DeclarationContextDecision[];
} {
  const facts: CheckerDependencyFact[] = [];
  const collection = readReferenceGraphFacts({
    compilationObligationScope: 'generated-declaration-project-v1',
    caches: options.caches,
    context: createAutoProjectSemanticContext({
      authority: options.state.semanticAuthority,
      project: options.project,
      workspaceSourceBoundary: options.workspaceSourceBoundary,
    }),
    importAnalysis: options.importAnalysis,
  });
  const nativeFailures = collection.nativeEvidence?.failures ?? [];
  const run = coreCollectionRun(options.caches);
  for (const failure of nativeFailures) run.failureIds.add(failure.id);
  const declaration = collectDeclarationContextDecisions({
    policy: options.caches.declarationContextPolicy,
    project: options.project,
    evidence: collection.declarationEvidence,
    unsupportedDependencies: collection.dependencies,
    allowUnqualifiedLocal: !['typescript', 'vue'].includes(
      options.state.semanticAuthority.family,
    ),
    coverageIndex: options.caches.sourceConfigCoverage,
    isWorkspaceFile:
      options.workspaceSourceBoundary.governance?.isWorkspaceFile,
  });
  const failures = collection.failures
    .filter(
      (failure) =>
        !failure.importRecord ||
        declaration.isActiveSource(failure.importRecord.filePath),
    )
    .map((failure) => {
      const detail = formatProjectDependencyFailure({
        config: options.config,
        failure,
      });
      retainDependencyFailure(options.caches, failure, detail);
      return detail;
    });
  for (const dependency of collection.ownershipInputs) {
    if (
      !declaration.isActiveSource(dependency.importRecord.filePath) ||
      !shouldInferDeclarationReferenceFromImportRecord(dependency.importRecord)
    ) {
      continue;
    }
    facts.push(createLockedDependencyFact(options.project, dependency));
  }
  const supplementalProblems =
    options.state.semanticAuthority.source === 'baseline' &&
    collection.nativeEvidence
      ? assessMissingNativeImports({
          ...options,
          facts,
          records: collection.unresolvedNativeRecords.filter(({ record }) =>
            declaration.isActiveSource(record.filePath),
          ),
          snapshot: collection.nativeEvidence,
        })
      : [];
  return {
    facts,
    problems: [...declaration.problems, ...supplementalProblems],
    failures: [...nativeFailures.map((failure) => failure.detail), ...failures],
    declarationContexts: declaration.decisions,
  };
}

function getSupportedEvidenceKind(
  dependency: ReferenceDependency,
): CheckerDependencyFact['typeEvidenceKind'] {
  const evidence = dependency.typeEvidence;
  if (evidence === undefined) return 'unobserved';
  if (evidence.kind === 'unsupported-checker')
    throw new Error(
      'Unsupported evidence cannot become a locked dependency fact.',
    );
  return evidence.kind;
}
