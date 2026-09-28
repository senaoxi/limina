import type { ResolvedLiminaConfig } from '#config/runner';
import {
  formatImportRecordLocation,
  type ImportRecord,
} from '#core/import-graph/context';
import type { PackageOwner, WorkspacePackage } from '#core/workspace/actions';
import { toRelativePath } from '#utils/path';
import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import type { NearestPackageInfo } from '../core/packages/owners';
import { createSourceDiagnosticFinding } from './finding-utils';
import type { SourceFinding } from './findings';

export function addResolvedPackageWithoutNameProblem(options: {
  config: ResolvedLiminaConfig;
  findings: SourceFinding[];
  importRecord: ImportRecord;
  owner: PackageOwner;
  packageInfo: NearestPackageInfo;
}): void {
  const title = 'Resolved package import has no package name';
  const reason =
    'source imports can only be authorized against a named package.json dependency.';
  const lines = [
    `${title}:`,
    `  source owner: ${toRelativePath(options.config.rootDir, options.owner.packageJsonPath)}`,
    `  file: ${formatImportRecordLocation(options.config.rootDir, options.importRecord)}`,
    `  imported specifier: ${options.importRecord.specifier}`,
    `  resolved package.json: ${toRelativePath(options.config.rootDir, options.packageInfo.packageJsonPath)}`,
    `  reason: ${reason}`,
  ];

  options.findings.push(
    createSourceDiagnosticFinding({
      code: LIMINA_CHECK_ISSUE_CODES.sourcePackageImportInvalid,
      facts: {
        importerPath: options.importRecord.filePath,
        kind: 'resolved-package-name-missing',
        line: options.importRecord.line,
        packageManifestPath: options.owner.packageJsonPath,
        packageName: options.owner.name ?? undefined,
        resolvedPackageManifestPath: options.packageInfo.packageJsonPath,
        specifier: options.importRecord.specifier,
      },
      filePath: options.importRecord.filePath,
      lines,
      ownerName: options.owner.name ?? undefined,
      packageJsonPath: options.owner.packageJsonPath,
      reason,
      title,
    }),
  );
}

function getWorkspacePackageName(
  workspacePackage: WorkspacePackage | null,
): string | undefined {
  return workspacePackage ? workspacePackage.name : undefined;
}

function getTargetPackageName(options: {
  targetOwner: PackageOwner;
  workspacePackage: WorkspacePackage | null;
}): string | undefined {
  if (options.targetOwner.name) {
    return options.targetOwner.name;
  }

  return getWorkspacePackageName(options.workspacePackage);
}

function createWorkspacePackageLines(
  workspacePackage: WorkspacePackage | null,
): string[] {
  const packageName = getWorkspacePackageName(workspacePackage);
  return packageName ? [`  workspace package: ${packageName}`] : [];
}

export function addPackageImportOtherOwnerProblem(options: {
  config: ResolvedLiminaConfig;
  findings: SourceFinding[];
  importRecord: ImportRecord;
  owner: PackageOwner;
  resolvedFilePath: string;
  targetOwner: PackageOwner;
  workspacePackage: WorkspacePackage | null;
}): void {
  const title = 'Package import resolves to another source owner';
  const reason =
    '#... package imports must not resolve to modules governed by another source owner.';
  const lines = [
    `${title}:`,
    `  source owner: ${toRelativePath(options.config.rootDir, options.owner.packageJsonPath)}`,
    `  file: ${formatImportRecordLocation(options.config.rootDir, options.importRecord)}`,
    `  imported specifier: ${options.importRecord.specifier}`,
    `  target source owner: ${toRelativePath(options.config.rootDir, options.targetOwner.packageJsonPath)}`,
    ...createWorkspacePackageLines(options.workspacePackage),
    `  reason: ${reason}`,
  ];

  options.findings.push(
    createSourceDiagnosticFinding({
      code: LIMINA_CHECK_ISSUE_CODES.sourcePackageImportInvalid,
      facts: {
        importerPath: options.importRecord.filePath,
        kind: 'other-owner-target',
        line: options.importRecord.line,
        packageManifestPath: options.owner.packageJsonPath,
        packageName: options.owner.name ?? undefined,
        resolvedTargetPath: options.resolvedFilePath,
        specifier: options.importRecord.specifier,
        targetPackageManifestPath: options.targetOwner.packageJsonPath,
        targetPackageName: getTargetPackageName(options),
      },
      filePath: options.importRecord.filePath,
      lines,
      ownerName: options.owner.name ?? undefined,
      packageJsonPath: options.owner.packageJsonPath,
      reason,
      title,
    }),
  );
}

function createTargetScopeLines(options: {
  config: ResolvedLiminaConfig;
  targetPackageScope: NearestPackageInfo | null;
}): string[] {
  if (!options.targetPackageScope) {
    return [];
  }

  return [
    `  target package scope: ${toRelativePath(options.config.rootDir, options.targetPackageScope.packageJsonPath)}`,
  ];
}

function getTargetScopeFact(targetPackageScope: NearestPackageInfo | null): {
  targetPackageManifestPath?: string;
  targetPackageName?: string;
} {
  if (!targetPackageScope) {
    return {};
  }

  return {
    targetPackageManifestPath: targetPackageScope.packageJsonPath,
    targetPackageName: targetPackageScope.name ?? undefined,
  };
}

export function addPackageImportRelativeScopeProblem(options: {
  config: ResolvedLiminaConfig;
  findings: SourceFinding[];
  importRecord: ImportRecord;
  owner: PackageOwner;
  packageScope: NearestPackageInfo;
  resolvedFilePath: string;
  targetPackageScope: NearestPackageInfo | null;
}): void {
  const title = 'Package import relative target escapes package scope';
  const reason =
    '#... package imports with relative targets must stay inside the declaring package scope.';
  const lines = [
    `${title}:`,
    `  source owner: ${toRelativePath(options.config.rootDir, options.owner.packageJsonPath)}`,
    `  package scope: ${toRelativePath(options.config.rootDir, options.packageScope.packageJsonPath)}`,
    `  file: ${formatImportRecordLocation(options.config.rootDir, options.importRecord)}`,
    `  imported specifier: ${options.importRecord.specifier}`,
    `  resolved file: ${toRelativePath(options.config.rootDir, options.resolvedFilePath)}`,
    ...createTargetScopeLines(options),
    `  reason: ${reason}`,
  ];

  options.findings.push(
    createSourceDiagnosticFinding({
      code: LIMINA_CHECK_ISSUE_CODES.sourcePackageImportInvalid,
      facts: {
        importerPath: options.importRecord.filePath,
        kind: 'target-escapes-package-scope',
        line: options.importRecord.line,
        packageManifestPath: options.owner.packageJsonPath,
        packageName: options.owner.name ?? undefined,
        resolvedTargetPath: options.resolvedFilePath,
        specifier: options.importRecord.specifier,
        ...getTargetScopeFact(options.targetPackageScope),
      },
      filePath: options.importRecord.filePath,
      lines,
      ownerName: options.owner.name ?? undefined,
      packageJsonPath: options.owner.packageJsonPath,
      reason,
      title,
    }),
  );
}
