import type { ResolvedLiminaConfig } from '#config/runner';
import { toRelativePath } from '#utils/path';
import type { ImportAnalysisContext } from '../import-analysis/runner';
import { shouldInferDeclarationReferenceFromImportRecord } from '../import-graph/declaration-reference-evidence';
import {
  collectProjectDependencies,
  createAutoProjectSemanticContext,
  type createProjectDependencyCaches,
  type ProjectDependency,
  type ProjectDependencyFailure,
} from '../project-dependencies/runner';
import type { AutoScopeProject } from './auto-checker-types';
import type {
  CheckerDependencyFact,
  TypeConfigOwnershipState,
} from './checker-ownership-types';

function formatProjectDependencyFailure(options: {
  config: ResolvedLiminaConfig;
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
  if (dependency.targetKind === 'source') {
    return {
      consumerConfigPath: project.configPath,
      importRecord: dependency.importRecord,
      physicalTargetPath: dependency.resolvedFilePath,
      physicalTargetProvenance: 'checker-source',
      typeEvidenceKind: 'checker-source',
    };
  }
  return {
    consumerConfigPath: project.configPath,
    importRecord: dependency.importRecord,
    physicalTargetPath: null,
    physicalTargetProvenance: null,
    typeEvidenceKind: 'concrete-declaration',
  };
}

export function collectLockedProjectFacts(options: {
  caches: ReturnType<typeof createProjectDependencyCaches>;
  config: ResolvedLiminaConfig;
  importAnalysis: ImportAnalysisContext;
  project: AutoScopeProject;
  state: TypeConfigOwnershipState & {
    semanticAuthority: Extract<
      TypeConfigOwnershipState['semanticAuthority'],
      { kind: 'locked' }
    >;
  };
}): { facts: CheckerDependencyFact[]; problems: string[] } {
  const facts: CheckerDependencyFact[] = [];
  const collection = collectProjectDependencies({
    caches: options.caches,
    context: createAutoProjectSemanticContext({
      authority: options.state.semanticAuthority,
      project: options.project,
    }),
    importAnalysis: options.importAnalysis,
  });
  const problems = collection.failures.map((failure) =>
    formatProjectDependencyFailure({ config: options.config, failure }),
  );
  for (const dependency of collection.dependencies) {
    if (
      !shouldInferDeclarationReferenceFromImportRecord(dependency.importRecord)
    ) {
      continue;
    }
    facts.push(createLockedDependencyFact(options.project, dependency));
  }
  return { facts, problems };
}
