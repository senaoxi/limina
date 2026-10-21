import type { ResolvedLiminaInputs } from '#config/runner';
import { toRelativePath } from '#utils/path';
import type { ImportAnalysisContext } from '../import-analysis/runner';
import { shouldInferDeclarationReferenceFromImportRecord } from '../import-graph/declaration-reference-evidence';
import { effectiveReferenceInputs } from '../project-dependencies/declaration-projection';
import {
  collectProjectDependencies,
  createAutoProjectSemanticContext,
  type createProjectDependencyCaches,
  type ProjectDependency,
  type ProjectDependencyFailure,
} from '../project-dependencies/runner';
import type { WorkspaceSourceBoundary } from '../typescript-semantic';
import { retainDependencyFailure } from './analysis-failure';
import type { AutoScopeProject } from './auto-checker-types';
import type {
  CheckerDependencyFact,
  TypeConfigOwnershipState,
} from './checker-ownership-types';

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
  dependency: ProjectDependency,
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
}): { facts: CheckerDependencyFact[]; problems: string[]; failures: string[] } {
  const facts: CheckerDependencyFact[] = [];
  const collection = collectProjectDependencies({
    compilationObligationScope: 'generated-declaration-project-v1',
    caches: options.caches,
    context: createAutoProjectSemanticContext({
      authority: options.state.semanticAuthority,
      project: options.project,
      workspaceSourceBoundary: options.workspaceSourceBoundary,
    }),
    importAnalysis: options.importAnalysis,
  });
  const failures = collection.failures.map((failure) => {
    const detail = formatProjectDependencyFailure({
      config: options.config,
      failure,
    });
    retainDependencyFailure(options.caches, failure, detail);
    return detail;
  });
  const dependencies = lockedDependencies(collection);
  for (const dependency of dependencies) {
    if (
      !shouldInferDeclarationReferenceFromImportRecord(dependency.importRecord)
    ) {
      continue;
    }
    facts.push(createLockedDependencyFact(options.project, dependency));
  }
  return { facts, problems: [], failures };
}

function getSupportedEvidenceKind(
  dependency: ProjectDependency,
): CheckerDependencyFact['typeEvidenceKind'] {
  const evidence = dependency.typeEvidence;
  if (evidence === undefined) return 'unobserved';
  if (evidence.kind === 'unsupported-checker')
    throw new Error(
      'Unsupported evidence cannot become a locked dependency fact.',
    );
  return evidence.kind;
}

function lockedDependencies(
  collection: ReturnType<typeof collectProjectDependencies>,
) {
  return collection.nativeEvidence === undefined
    ? effectiveReferenceInputs(collection)
    : collection.dependencies;
}
