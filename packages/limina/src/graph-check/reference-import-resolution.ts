import type { ImportRecord, ProjectInfo } from '#core/import-graph/context';
import type { ProjectDependency } from '../core/project-dependencies/contracts';
import { getResolvedWorkspacePackage } from './import-resolution-utilities';
import {
  type ManagedResolution,
  resolveManagedOutput,
} from './managed-output-resolution';
import type {
  ExpectedReferenceCollectionContext,
  GraphImportResolution,
} from './reference-types';

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
  return options.projectDependency.referenceRequirement === null
    ? null
    : resolveImportForGraphGovernance(options);
}

export function resolveImportForGraphGovernance(
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

  return createAllowedResolution({
    base: options,
    managed,
    targetPackage,
  });
}
