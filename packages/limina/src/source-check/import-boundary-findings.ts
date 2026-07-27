import type { ResolvedLiminaConfig } from '#config/runner';
import {
  formatImportRecordLocation,
  type ImportRecord,
} from '#core/import-graph/context';
import type { PackageOwner } from '#core/workspace/actions';
import { toRelativePath } from '#utils/path';
import path from 'pathe';
import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import type { NearestPackageInfo } from '../core/packages/owners';
import {
  getWorkspaceRegionBoundaryExclusionReason,
  type WorkspaceRegionBoundary,
} from '../core/workspace/regions';
import { createSourceDiagnosticFinding } from './finding-utils';
import type { SourceFinding } from './findings';

function getOwnerName(owner: PackageOwner): string | undefined {
  return owner.name ?? undefined;
}

function getPackageManifestPath(
  scope: NearestPackageInfo | null,
): string | undefined {
  return scope ? scope.packageJsonPath : undefined;
}

function createPackageScopeLine(options: {
  config: ResolvedLiminaConfig;
  label: string;
  scope: NearestPackageInfo | null;
}): string[] {
  if (!options.scope) {
    return [];
  }

  return [
    `  ${options.label}: ${toRelativePath(options.config.rootDir, options.scope.packageJsonPath)}`,
  ];
}

export function addRelativeImportOwnerProblem(options: {
  config: ResolvedLiminaConfig;
  importRecord: ImportRecord;
  owner: PackageOwner;
  findings: SourceFinding[];
  resolvedFilePath: string;
  sourcePackageScope: NearestPackageInfo | null;
  targetPackageScope: NearestPackageInfo | null;
}): void {
  const title = 'Relative import escapes package scope';
  const reason =
    'relative source imports must not cross the nearest package.json package boundary.';
  const lines = [
    `${title}:`,
    `  source owner: ${toRelativePath(options.config.rootDir, options.owner.packageJsonPath)}`,
    ...createPackageScopeLine({
      config: options.config,
      label: 'package scope',
      scope: options.sourcePackageScope,
    }),
    `  file: ${formatImportRecordLocation(options.config.rootDir, options.importRecord)}`,
    `  imported specifier: ${options.importRecord.specifier}`,
    `  resolved file: ${toRelativePath(options.config.rootDir, options.resolvedFilePath)}`,
    ...createPackageScopeLine({
      config: options.config,
      label: 'target package scope',
      scope: options.targetPackageScope,
    }),
    `  reason: ${reason}`,
  ];

  options.findings.push(
    createSourceDiagnosticFinding({
      code: LIMINA_CHECK_ISSUE_CODES.sourceRelativeImportEscapesScope,
      facts: {
        importerPath: options.importRecord.filePath,
        kind: 'relative-import',
        line: options.importRecord.line,
        packageManifestPath: options.owner.packageJsonPath,
        packageName: getOwnerName(options.owner),
        packageScopeManifestPath: getPackageManifestPath(
          options.sourcePackageScope,
        ),
        resolvedTargetPath: options.resolvedFilePath,
        specifier: options.importRecord.specifier,
        targetPackageManifestPath: getPackageManifestPath(
          options.targetPackageScope,
        ),
      },
      filePath: options.importRecord.filePath,
      lines,
      ownerName: getOwnerName(options.owner),
      packageJsonPath: options.owner.packageJsonPath,
      reason,
      title,
    }),
  );
}

function getBoundaryConfigPath(boundary: WorkspaceRegionBoundary): string {
  return boundary.kind === 'pnpm-workspace'
    ? boundary.workspaceYamlPath
    : boundary.packageJsonPath;
}

function createBoundaryConfigLine(options: {
  boundary: WorkspaceRegionBoundary;
  config: ResolvedLiminaConfig;
}): string {
  const label =
    options.boundary.kind === 'pnpm-workspace'
      ? 'boundary config'
      : 'boundary manifest';

  return `  ${label}: ${toRelativePath(options.config.rootDir, getBoundaryConfigPath(options.boundary))}`;
}

function createExclusionLines(exclusionReason: string | null): string[] {
  return exclusionReason
    ? [`  excluded boundary reason: ${exclusionReason}`]
    : [];
}

export function addSourceCrossGovernanceBoundaryProblem(options: {
  boundary: WorkspaceRegionBoundary;
  config: ResolvedLiminaConfig;
  importRecord: ImportRecord;
  owner: PackageOwner;
  findings: SourceFinding[];
  resolvedFilePath: string;
}): void {
  const exclusionReason = getWorkspaceRegionBoundaryExclusionReason(
    options.boundary,
  );
  const title = 'Source import crosses governance boundary';
  const reason =
    'current-region source must not import source files beyond a stopped or excluded governance boundary during a single Limina run.';
  const fix =
    'remove the cross-boundary source import, activate an eligible package scope, or consume a published package artifact instead of local source.';
  const lines = [
    `${title}:`,
    `  source owner: ${toRelativePath(options.config.rootDir, options.owner.packageJsonPath)}`,
    `  file: ${formatImportRecordLocation(options.config.rootDir, options.importRecord)}`,
    `  imported specifier: ${options.importRecord.specifier}`,
    `  resolved file: ${toRelativePath(options.config.rootDir, options.resolvedFilePath)}`,
    `  current region: ${toRelativePath(options.config.rootDir, path.join(options.config.rootDir, 'pnpm-workspace.yaml'))}`,
    `  boundary kind: ${options.boundary.kind}`,
    `  boundary root: ${toRelativePath(options.config.rootDir, options.boundary.rootDir)}`,
    createBoundaryConfigLine(options),
    ...createExclusionLines(exclusionReason),
    `  reason: ${reason}`,
    `  fix: ${fix}`,
  ];

  options.findings.push(
    createSourceDiagnosticFinding({
      code: LIMINA_CHECK_ISSUE_CODES.sourceCrossGovernanceBoundary,
      facts: {
        boundary: {
          configPath: getBoundaryConfigPath(options.boundary),
          exclusion: exclusionReason ?? undefined,
          kind: options.boundary.kind,
          rootDir: options.boundary.rootDir,
        },
        importerPath: options.importRecord.filePath,
        kind: 'cross-governance-boundary',
        line: options.importRecord.line,
        packageManifestPath: options.owner.packageJsonPath,
        packageName: getOwnerName(options.owner),
        resolvedTargetPath: options.resolvedFilePath,
        specifier: options.importRecord.specifier,
      },
      filePath: options.importRecord.filePath,
      fix,
      lines,
      ownerName: getOwnerName(options.owner),
      packageJsonPath: options.owner.packageJsonPath,
      reason,
      title,
    }),
  );
}

export function addSourceImportOutsideActivatedRegionProblem(options: {
  config: ResolvedLiminaConfig;
  importRecord: ImportRecord;
  owner: PackageOwner;
  findings: SourceFinding[];
  resolvedFilePath: string;
}): void {
  const title =
    'Source import resolves outside activated workspace package regions';
  const reason =
    'current-run source governance is bounded by activated workspace packages; local repo files outside those packages cannot be imported as governed source.';
  const fix =
    'move the target into an activated workspace package, activate the owning package for this run, or consume it as a package artifact instead of a local source file.';
  const lines = [
    `${title}:`,
    `  source owner: ${toRelativePath(options.config.rootDir, options.owner.packageJsonPath)}`,
    `  file: ${formatImportRecordLocation(options.config.rootDir, options.importRecord)}`,
    `  imported specifier: ${options.importRecord.specifier}`,
    `  resolved file: ${toRelativePath(options.config.rootDir, options.resolvedFilePath)}`,
    `  reason: ${reason}`,
    `  fix: ${fix}`,
  ];

  options.findings.push(
    createSourceDiagnosticFinding({
      code: LIMINA_CHECK_ISSUE_CODES.sourceOwnerInvalid,
      facts: {
        importerPath: options.importRecord.filePath,
        kind: 'outside-activated-region',
        line: options.importRecord.line,
        packageManifestPath: options.owner.packageJsonPath,
        packageName: getOwnerName(options.owner),
        resolvedTargetPath: options.resolvedFilePath,
        specifier: options.importRecord.specifier,
      },
      filePath: options.importRecord.filePath,
      fix,
      lines,
      ownerName: getOwnerName(options.owner),
      packageJsonPath: options.owner.packageJsonPath,
      reason,
      title,
    }),
  );
}
