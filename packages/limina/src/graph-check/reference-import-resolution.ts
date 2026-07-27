import type { ImportRecord, ProjectInfo } from '#core/import-graph/context';
import { resolveDeclarationProvider } from '../core/import-graph/declaration-provider';
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
  addOxcOnlyDeclarationProviderProblem,
  addUnresolvedWorkspaceImportProblem,
} from './unresolved-import-findings';
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
}

type DeclarationProvider = ReturnType<typeof resolveDeclarationProvider>;
type WorkspaceExportResolution = ReturnType<
  typeof getWorkspaceExportResolution
>;

function getProviderResolvedPath(options: {
  provider: DeclarationProvider;
  workspaceResolvedPath: string | null;
}): string | null {
  if (
    options.provider.kind === 'declaration' ||
    options.provider.kind === 'source'
  ) {
    return options.provider.typeScriptResolution.resolvedFileName;
  }

  return options.workspaceResolvedPath;
}

function reportMissingProvider(options: {
  provider: DeclarationProvider;
  resolutionOptions: ImportResolutionOptions;
}): void {
  if (options.provider.kind === 'oxc-only') {
    addOxcOnlyDeclarationProviderProblem({
      context: options.resolutionOptions.context,
      importRecord: options.resolutionOptions.importRecord,
      oxcResolvedFilePath: options.provider.oxcResolvedFilePath,
      project: options.resolutionOptions.project,
    });
    return;
  }

  if (options.provider.kind === 'unresolved') {
    addUnresolvedWorkspaceImportProblem({
      context: options.resolutionOptions.context,
      importRecord: options.resolutionOptions.importRecord,
      project: options.resolutionOptions.project,
      targetPackage:
        options.resolutionOptions.context.workspaceLookup.findPackageForSpecifier(
          options.resolutionOptions.importRecord.specifier,
        ),
    });
  }
}

function isUnstableWorkspaceExport(
  resolution: WorkspaceExportResolution,
): boolean {
  if (!resolution) {
    return false;
  }

  return !resolution.hasTypeScriptStableEntry;
}

function getWorkspaceResolvedPath(
  resolution: WorkspaceExportResolution,
): string | null {
  return resolution?.typeScriptResolvedFileName ?? null;
}

function reportMissingProviderWhenNeeded(options: {
  provider: DeclarationProvider;
  resolutionOptions: ImportResolutionOptions;
  resolvedPath: string | null;
}): void {
  if (options.resolvedPath) {
    return;
  }

  reportMissingProvider(options);
}

function resolveProviderPath(options: {
  provider: DeclarationProvider;
  resolutionOptions: ImportResolutionOptions;
  workspaceExportResolution: WorkspaceExportResolution;
}): string | null {
  if (options.provider.kind === 'resource') {
    return null;
  }

  if (isUnstableWorkspaceExport(options.workspaceExportResolution)) {
    addWorkspacePackageExportWithoutTypeEntryProblem({
      context: options.resolutionOptions.context,
      importRecord: options.resolutionOptions.importRecord,
      project: options.resolutionOptions.project,
      resolution: options.workspaceExportResolution!,
    });
    return null;
  }

  const resolvedPath = getProviderResolvedPath({
    provider: options.provider,
    workspaceResolvedPath: getWorkspaceResolvedPath(
      options.workspaceExportResolution,
    ),
  });
  reportMissingProviderWhenNeeded({
    provider: options.provider,
    resolutionOptions: options.resolutionOptions,
    resolvedPath,
  });
  return resolvedPath;
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

function resolveDeclarationProviderForImport(
  options: ImportResolutionOptions,
): DeclarationProvider {
  return resolveDeclarationProvider({
    compilerOptions: options.project.options,
    containingFile: options.filePath,
    fileOwnerLookup: options.context.fileOwnerLookup,
    importAnalysis: options.context.importAnalysis,
    importRecord: options.importRecord,
    project: options.project,
  });
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
  const graphResolvedFilePath = resolveProviderPath({
    provider: resolveDeclarationProviderForImport(options),
    resolutionOptions: options,
    workspaceExportResolution,
  });
  if (!graphResolvedFilePath) {
    return null;
  }

  const managed = resolveManagedOutput({
    context: options.context,
    graphResolvedFilePath,
    importRecord: options.importRecord,
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
