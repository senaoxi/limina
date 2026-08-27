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
import {
  addWorkspacePackageExportWithoutTypeEntryProblem,
  getDeniedDepRuleForResolvedPackage,
  getTargetPackageForGraph,
  getWorkspaceExportResolution,
} from './workspace-import-findings';

interface ImportResolutionOptions {
  context: ExpectedReferenceCollectionContext;
  filePath: string;
  importRecord: ImportRecord;
  project: ProjectInfo;
  projectDependency: ProjectDependency;
}
type WorkspaceExportResolution = ReturnType<
  typeof getWorkspaceExportResolution
>;

function isUnstableWorkspaceExport(
  resolution: WorkspaceExportResolution,
): boolean {
  if (!resolution) {
    return false;
  }

  return !resolution.hasTypeScriptStableEntry;
}

function createAllowedResolution(options: {
  base: ImportResolutionOptions;
  managed: ManagedResolution;
  targetPackage: ReturnType<
    ExpectedReferenceCollectionContext['workspaceLookup']['findPackageForSpecifier']
  >;
  workspaceExportResolution: WorkspaceExportResolution;
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
    targetPackageForGraph: getTargetPackageForGraph({
      targetPackage: options.targetPackage,
      targetWorkspacePackageForResolved,
      useWorkspaceExportResolution: Boolean(options.workspaceExportResolution),
    }),
    targetWorkspacePackageForResolved,
    workspaceExportResolution: options.workspaceExportResolution,
  };
}

function resolveProjectDependencyPath(options: {
  dependency: ProjectDependency;
  resolutionOptions: ImportResolutionOptions;
  workspaceExportResolution: WorkspaceExportResolution;
}): string | null {
  if (isUnstableWorkspaceExport(options.workspaceExportResolution)) {
    addWorkspacePackageExportWithoutTypeEntryProblem({
      context: options.resolutionOptions.context,
      importRecord: options.resolutionOptions.importRecord,
      project: options.resolutionOptions.project,
      resolution: options.workspaceExportResolution!,
    });
    return null;
  }
  return options.dependency.resolvedFilePath;
}

export function resolveImportForReferenceExpectation(
  options: ImportResolutionOptions,
): GraphImportResolution | null {
  const targetPackage = options.context.workspaceLookup.findPackageForSpecifier(
    options.importRecord.specifier,
  );
  const workspaceExportResolution = getWorkspaceExportResolution({
    ...options,
    targetPackage,
  });
  const graphResolvedFilePath = resolveProjectDependencyPath({
    dependency: options.projectDependency,
    resolutionOptions: options,
    workspaceExportResolution,
  });
  if (!graphResolvedFilePath) {
    return null;
  }

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
    workspaceExportResolution,
  });
}
