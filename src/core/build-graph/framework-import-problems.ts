import type { ImportRecord } from '#core/import-analysis/runner';
import { formatImportRecordLocation } from '#core/import-graph/context';
import { getPackageRootSpecifier } from '#core/workspace/actions';
import {
  isBarePackageSpecifier,
  isRelativeSpecifier,
} from '#utils/module-specifier';
import { toRelativePath } from '#utils/path';
import path from 'pathe';
import type { ReferenceImportContext } from './reference-import-types';
import type { GovernedSourceUnit } from './types';

function isRelativeOrAbsoluteSpecifier(specifier: string): boolean {
  return [isRelativeSpecifier(specifier), path.isAbsolute(specifier)].some(
    Boolean,
  );
}

function isGeneratedAliasSpecifier(specifier: string): boolean {
  return specifier === '$lib' || specifier.startsWith('$lib/');
}

function isWorkspacePackageSpecifier(
  context: ReferenceImportContext,
  specifier: string,
): boolean {
  if (!isBarePackageSpecifier(specifier)) return false;
  const packageName = getPackageRootSpecifier(specifier);
  return context.activatedRegions.packages.some(
    (workspacePackage) => workspacePackage.name === packageName,
  );
}

function isUnresolvedGovernedSpecifier(
  context: ReferenceImportContext,
  specifier: string,
): boolean {
  return [
    isRelativeOrAbsoluteSpecifier(specifier),
    isGeneratedAliasSpecifier(specifier),
    isWorkspacePackageSpecifier(context, specifier),
  ].some(Boolean);
}

function addUnresolvedFrameworkImportProblem(options: {
  context: ReferenceImportContext;
  importRecord: ImportRecord;
  source: GovernedSourceUnit;
}): void {
  options.context.problems.push(
    [
      'Unable to resolve framework source import:',
      `  importing config: ${toRelativePath(options.context.config.rootDir, options.source.configPath)}`,
      `  file: ${formatImportRecordLocation(options.context.config.rootDir, options.importRecord)}`,
      `  import domain: ${options.importRecord.domain}`,
      `  imported specifier: ${options.importRecord.specifier}`,
      '  reason: a local, generated-alias, or workspace import was not resolved to a governed source file.',
      '  fix: check the source path, generated framework types, paths/baseUrl, package exports, and workspace dependency installation.',
    ].join('\n'),
  );
}

export function reportUnresolvedFrameworkImport(options: {
  context: ReferenceImportContext;
  importRecord: ImportRecord;
  resolutionFound: boolean;
  source: GovernedSourceUnit;
}): void {
  if (options.resolutionFound) return;
  if (
    !isUnresolvedGovernedSpecifier(
      options.context,
      options.importRecord.specifier,
    )
  ) {
    return;
  }
  addUnresolvedFrameworkImportProblem(options);
}
