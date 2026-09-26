import type { ImportRecord, ProjectInfo } from '#core/import-graph/context';
import type { ProjectDependency } from '../core/project-dependencies/contracts';
import { addDeniedDepImportProblem } from './import-access-denied';
import { getResolvedWorkspacePackage } from './import-resolution-utils';
import {
  type ManagedResolution,
  resolveManagedOutput,
} from './managed-output-resolution';
import type {
  ExpectedReferenceCollectionContext,
  GraphImportResolution,
} from './reference-types';
import { getDeniedDepRuleForResolvedPackage } from './workspace-import-findings';

interface ImportResolutionOptions {
  context: ExpectedReferenceCollectionContext;
  filePath: string;
  importRecord: ImportRecord;
  project: ProjectInfo;
  projectDependency: ProjectDependency;
}
function createAllowedResolution(options: {
  base: ImportResolutionOptions;
  managed: ManagedResolution;
  targetPackage: ReturnType<
    ExpectedReferenceCollectionContext['workspaceLookup']['findPackageForSpecifier']
  >;
}): GraphImportResolution | null {
  const deniedRule = getDeniedDepRuleForResolvedPackage({
    context: options.base.context,
    project: options.base.project,
    resolvedFilePath: options.managed.resolvedFilePath,
  });
  if (deniedRule) {
    addDeniedDepImportProblem({
      config: options.base.context.config,
      findings: options.base.context.findings,
      importRecord: options.base.importRecord,
      project: options.base.project,
      projectCheckerNamesByPath: options.base.context.projectCheckerNamesByPath,
      rule: deniedRule,
    });
    return null;
  }

  const targetWorkspacePackageForResolved = getResolvedWorkspacePackage(
    options.managed.resolvedFilePath,
    options.base.context.workspaceLookup,
  );

  return {
    graphResolvedFilePath: options.managed.resolvedFilePath,
    importer: options.base.context.workspaceLookup.findImporterForFile(
      options.base.importRecord.filePath,
    ),
    managedOutputAttribution: options.managed.attribution,
    managedOutputTargetProjectPath: options.managed.targetProjectPath,
    resolvedFilePath: options.managed.resolvedFilePath,
    targetPackage: options.targetPackage,
    targetPackageForGraph: targetWorkspacePackageForResolved,
    targetWorkspacePackageForResolved,
  };
}

export function resolveImportForReferenceExpectation(
  options: ImportResolutionOptions,
): GraphImportResolution | null {
  const targetPackage = options.context.workspaceLookup.findPackageForSpecifier(
    options.importRecord.specifier,
  );
  const graphResolvedFilePath = options.projectDependency.resolvedFilePath;

  const managed = resolveManagedOutput({
    context: options.context,
    graphResolvedFilePath,
    project: options.project,
  });
  if (!managed) {
    return null;
  }

  return createExpectedDeclarationResolution({
    base: options,
    managed,
    targetPackage,
  });
}

function createExpectedDeclarationResolution(
  options: Parameters<typeof createAllowedResolution>[0],
): GraphImportResolution | null {
  const resolution = createAllowedResolution(options);
  return options.base.projectDependency.referenceRequirement === null
    ? null
    : resolution;
}
