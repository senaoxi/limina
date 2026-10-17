import { isNativeTypeScriptProjectInput } from '#checkers';
import type { ImportRecord } from '#core/import-analysis/runner';
import { formatImportRecordLocation } from '#core/import-graph/context';
import { getPackageRootSpecifier } from '#core/workspace/actions';
import {
  getPlainSpecifierExtension,
  hasModuleSpecifierQueryOrFragment,
  isBarePackageSpecifier,
  isRelativeSpecifier,
} from '#utils/module-specifier';
import { isPathInsideDirectory, toRelativePath } from '#utils/path';
import path from 'pathe';
import { isKnownFrameworkVirtualSpecifier } from '../import-analysis/virtual-modules';
import type { ProjectDependency } from '../project-dependencies/contracts';
import type { ReferenceImportContext } from './reference-import-types';
import { isInsideNodeModules } from './source-projects';
import type { GovernedSourceUnit, SourceProject } from './types';

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
  extensions: readonly string[] = [],
): boolean {
  if (
    [
      hasModuleSpecifierQueryOrFragment(specifier),
      isKnownFrameworkVirtualSpecifier(specifier),
      isExplicitResourceSpecifier(specifier, extensions),
    ].some(Boolean)
  )
    return false;
  return [
    isRelativeOrAbsoluteSpecifier(specifier),
    isGeneratedAliasSpecifier(specifier),
    isWorkspacePackageSpecifier(context, specifier),
  ].some(Boolean);
}

function isExplicitResourceSpecifier(
  specifier: string,
  extensions: readonly string[],
): boolean {
  return [
    isRelativeOrAbsoluteSpecifier(specifier),
    getPlainSpecifierExtension(specifier) !== null,
    !isNativeTypeScriptProjectInput(specifier),
    ['.astro', '.svelte', '.vue', '.json', ...extensions].every(
      (extension) => !specifier.toLowerCase().endsWith(extension.toLowerCase()),
    ),
  ].every(Boolean);
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
  if (
    options.resolutionFound ||
    !isUnresolvedGovernedSpecifier(
      options.context,
      options.importRecord.specifier,
      options.source.context.extensions,
    )
  ) {
    return;
  }
  addUnresolvedFrameworkImportProblem(options);
}

interface ContributionOptions {
  context: ReferenceImportContext;
  frameworkFiles: ReadonlySet<string>;
  project: SourceProject;
  projectDependency: ProjectDependency;
}
export function isFrameworkContribution(options: ContributionOptions): boolean {
  const fileName = options.projectDependency.importRecord.filePath;
  return (
    options.frameworkFiles.has(fileName) ||
    isSupportContribution(options, fileName)
  );
}
function isSupportContribution(
  options: ContributionOptions,
  fileName: string,
): boolean {
  return (
    !options.project.fileNames.includes(fileName) &&
    isGovernedSupportTarget(options)
  );
}
function isGovernedSupportTarget(options: ContributionOptions): boolean {
  const target = options.projectDependency.resolvedFilePath;
  return (
    options.context.workspaceSourceBoundary.has(target) ||
    isLocalSupportTarget(options.context, target)
  );
}
function isLocalSupportTarget(
  context: ReferenceImportContext,
  target: string,
): boolean {
  return (
    !isInsideNodeModules(target) &&
    isPathInsideDirectory(target, context.config.rootDir)
  );
}
