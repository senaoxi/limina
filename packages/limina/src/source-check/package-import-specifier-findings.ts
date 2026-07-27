import type { ResolvedLiminaConfig } from '#config/runner';
import {
  formatImportRecordLocation,
  type ImportRecord,
} from '#core/import-graph/context';
import type { PackageOwner } from '#core/workspace/actions';
import { toRelativePath } from '#utils/path';
import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import type { NearestPackageInfo } from '../core/packages/owners';
import { createSourceDiagnosticFinding } from './finding-utils';
import type { SourceFinding } from './findings';

interface SpecifierFindingOptions {
  config: ResolvedLiminaConfig;
  findings: SourceFinding[];
  importRecord: ImportRecord;
  owner: PackageOwner;
  packageScope: NearestPackageInfo | null;
}

function createPackageScopeLines(options: {
  config: ResolvedLiminaConfig;
  packageScope: NearestPackageInfo | null;
}): string[] {
  if (!options.packageScope) {
    return [];
  }

  return [
    `  package scope: ${toRelativePath(options.config.rootDir, options.packageScope.packageJsonPath)}`,
  ];
}

function addSpecifierFinding(options: {
  base: SpecifierFindingOptions;
  kind: 'specifier-unauthorized' | 'specifier-unresolved';
  reason: string;
  title: string;
}): void {
  const lines = [
    `${options.title}:`,
    `  source owner: ${toRelativePath(options.base.config.rootDir, options.base.owner.packageJsonPath)}`,
    ...createPackageScopeLines(options.base),
    `  file: ${formatImportRecordLocation(options.base.config.rootDir, options.base.importRecord)}`,
    `  imported specifier: ${options.base.importRecord.specifier}`,
    `  reason: ${options.reason}`,
  ];

  options.base.findings.push(
    createSourceDiagnosticFinding({
      code: LIMINA_CHECK_ISSUE_CODES.sourcePackageImportInvalid,
      facts: {
        importerPath: options.base.importRecord.filePath,
        kind: options.kind,
        line: options.base.importRecord.line,
        packageManifestPath: options.base.owner.packageJsonPath,
        packageName: options.base.owner.name ?? undefined,
        specifier: options.base.importRecord.specifier,
      },
      filePath: options.base.importRecord.filePath,
      lines,
      ownerName: options.base.owner.name ?? undefined,
      packageJsonPath: options.base.owner.packageJsonPath,
      reason: options.reason,
      title: options.title,
    }),
  );
}

export function addUnauthorizedPackageImportSpecifier(
  options: SpecifierFindingOptions,
): void {
  addSpecifierFinding({
    base: options,
    kind: 'specifier-unauthorized',
    reason:
      '#... package imports must match the nearest package scope package.json imports field.',
    title: 'Unauthorized package import specifier',
  });
}

export function addUnresolvedPackageImportSpecifier(
  options: SpecifierFindingOptions,
): void {
  addSpecifierFinding({
    base: options,
    kind: 'specifier-unresolved',
    reason:
      'matched #... package imports must resolve from the nearest package scope package.json imports field.',
    title: 'Unresolved package import specifier',
  });
}

export function addPackageImportOutsideSourceOwnership(options: {
  config: ResolvedLiminaConfig;
  findings: SourceFinding[];
  importRecord: ImportRecord;
  owner: PackageOwner;
  resolvedFilePath: string;
}): void {
  const title = 'Package import resolves outside source ownership';
  const reason =
    '#... package imports must resolve to the current source owner or to a named artifact package dependency.';
  const lines = [
    `${title}:`,
    `  source owner: ${toRelativePath(options.config.rootDir, options.owner.packageJsonPath)}`,
    `  file: ${formatImportRecordLocation(options.config.rootDir, options.importRecord)}`,
    `  imported specifier: ${options.importRecord.specifier}`,
    `  resolved file: ${toRelativePath(options.config.rootDir, options.resolvedFilePath)}`,
    `  reason: ${reason}`,
  ];

  options.findings.push(
    createSourceDiagnosticFinding({
      code: LIMINA_CHECK_ISSUE_CODES.sourcePackageImportInvalid,
      facts: {
        importerPath: options.importRecord.filePath,
        kind: 'outside-source-ownership',
        line: options.importRecord.line,
        packageManifestPath: options.owner.packageJsonPath,
        packageName: options.owner.name ?? undefined,
        resolvedTargetPath: options.resolvedFilePath,
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
