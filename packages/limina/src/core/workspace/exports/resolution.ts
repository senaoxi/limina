import {
  type CheckerProjectParseContext,
  normalizeExtensions,
} from '#checkers';
import type { ResolvedLiminaConfig } from '#config/runner';
import type { ImportAnalysisContext } from '#core/import-analysis/runner';
import {
  candidatePathsForBasePath,
  resolveExistingFilePath,
} from '#utils/module-resolution';
import { toPosixPath } from '#utils/path';
import path from 'pathe';
import type {
  PackageExportEntry,
  WorkspaceExportsResolutionProfile,
} from './types';

const declarationModulePattern = /\.d\.(?:cts|mts|ts)$/u;
const runtimeTargetPattern = /\.(?:cjs|mjs|js)$/u;

function getProfileContext(
  profile: WorkspaceExportsResolutionProfile,
): CheckerProjectParseContext & {
  configPath: string;
  resolverConfigPath: string;
} {
  return {
    checkerPresets: profile.checkerPresets,
    configPath: profile.configPath,
    extensions: profile.extensions,
    resolverConfigPath: profile.resolverConfigPath,
  };
}

function pathMatchesExtension(
  filePath: string,
  extensions: readonly string[],
): boolean {
  return normalizeExtensions([...extensions]).some((extension) =>
    filePath.endsWith(extension),
  );
}

function stripDotSlash(value: string): string {
  return value.startsWith('./') ? value.slice('./'.length) : value;
}

function getTargetCandidatePaths(options: {
  entry: PackageExportEntry;
  extensions: readonly string[];
  target: string;
}): string[] {
  if (!options.target.startsWith('./')) return [];
  const targetPath = path.resolve(
    options.entry.packageDirectory,
    stripDotSlash(options.target),
  );
  return candidatePathsForBasePath(
    targetPath,
    normalizeExtensions([...options.extensions]),
  );
}

function isMatchingResolvedPath(options: {
  extensions: readonly string[];
  resolvedPath: string | null;
}): options is { extensions: readonly string[]; resolvedPath: string } {
  if (options.resolvedPath === null) return false;
  return pathMatchesExtension(options.resolvedPath, options.extensions);
}

function resolveTargetWithCheckerExtensions(options: {
  entry: PackageExportEntry;
  extensions: readonly string[];
}): string | null {
  const candidates = options.entry.targets.flatMap((target) =>
    getTargetCandidatePaths({ ...options, target }),
  );
  for (const candidate of candidates) {
    const resolvedPath = resolveExistingFilePath(candidate);
    const result = { extensions: options.extensions, resolvedPath };
    if (isMatchingResolvedPath(result)) return result.resolvedPath;
  }
  return null;
}

export function resolveTypeScriptExport(options: {
  entry: PackageExportEntry;
  importAnalysis: ImportAnalysisContext;
  profile: WorkspaceExportsResolutionProfile;
}): string | null {
  const containingFile = path.join(
    options.entry.packageDirectory,
    'package.json',
  );
  const resolved = options.importAnalysis.resolveTypeScriptImport(
    options.entry.specifier,
    containingFile,
    options.profile.options,
    getProfileContext(options.profile),
  )?.resolvedFileName;
  if (resolved !== undefined) return resolved;
  return resolveTargetWithCheckerExtensions({
    entry: options.entry,
    extensions: options.profile.extensions,
  });
}

export function resolveOxcExport(options: {
  entry: PackageExportEntry;
  importAnalysis: ImportAnalysisContext;
  profile: WorkspaceExportsResolutionProfile;
}): string | null {
  return options.importAnalysis.resolveOxcImport(
    options.entry.specifier,
    path.join(options.entry.packageDirectory, 'package.json'),
    options.profile.options,
    getProfileContext(options.profile),
  );
}

function getDeclarationOnlyOxcFallback(
  typeScriptResolvedFileName: string | null,
): string | null {
  if (typeScriptResolvedFileName === null) return null;
  return declarationModulePattern.test(typeScriptResolvedFileName)
    ? typeScriptResolvedFileName
    : null;
}

export function getEffectiveOxcResolvedFileName(options: {
  oxcResolvedFileName: string | null;
  typeScriptResolvedFileName: string | null;
}): string | null {
  if (options.oxcResolvedFileName !== null) return options.oxcResolvedFileName;
  return getDeclarationOnlyOxcFallback(options.typeScriptResolvedFileName);
}

function isParentRelativePath(relativePath: string): boolean {
  if (relativePath === '..') return true;
  return relativePath.startsWith('../');
}

function isLocalRelativePath(relativePath: string): boolean {
  if (relativePath.length === 0) return false;
  if (isParentRelativePath(relativePath)) return false;
  return !path.isAbsolute(relativePath);
}

export function getDisplayPath(
  config: ResolvedLiminaConfig,
  filePath: string,
): string {
  const relativePath = toPosixPath(path.relative(config.rootDir, filePath));
  return isLocalRelativePath(relativePath)
    ? relativePath
    : toPosixPath(filePath);
}

function uniqueValues(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export function formatExportTargets(targets: readonly string[]): string[] {
  return uniqueValues(targets);
}

function getRuntimeCandidatePath(options: {
  config: ResolvedLiminaConfig;
  entry: PackageExportEntry;
  target: string;
}): string[] {
  if (!options.target.startsWith('./')) return [];
  if (!runtimeTargetPattern.test(options.target)) return [];
  const resolved = path.resolve(
    options.entry.packageDirectory,
    stripDotSlash(options.target),
  );
  return [getDisplayPath(options.config, resolved)];
}

export function getRuntimeCandidatePaths(options: {
  config: ResolvedLiminaConfig;
  entry: PackageExportEntry;
}): string[] {
  const candidates = options.entry.targets.flatMap((target) =>
    getRuntimeCandidatePath({ ...options, target }),
  );
  return uniqueValues(candidates);
}

function getRuntimeDeclarationExtension(target: string): string | null {
  const extensions: Readonly<Record<string, string>> = {
    '.cjs': '.d.cts',
    '.js': '.d.ts',
    '.mjs': '.d.mts',
  };
  const extension = Object.keys(extensions).find((key) => target.endsWith(key));
  return extension === undefined ? null : extensions[extension]!;
}

function getDeclarationCandidateForRuntimeTarget(
  target: string,
): string | null {
  if (declarationModulePattern.test(target)) return target;
  const runtimeExtension = getRuntimeDeclarationExtension(target);
  if (runtimeExtension === null) return null;
  const extensionLength = path.extname(target).length;
  return `${target.slice(0, -extensionLength)}${runtimeExtension}`;
}

function getDeclarationCandidatePath(options: {
  config: ResolvedLiminaConfig;
  entry: PackageExportEntry;
  target: string;
}): string[] {
  if (!options.target.startsWith('./')) return [];
  const declarationTarget = getDeclarationCandidateForRuntimeTarget(
    options.target,
  );
  if (declarationTarget === null) return [];
  const resolved = path.resolve(
    options.entry.packageDirectory,
    stripDotSlash(declarationTarget),
  );
  return [getDisplayPath(options.config, resolved)];
}

export function getDeclarationCandidatePaths(options: {
  config: ResolvedLiminaConfig;
  entry: PackageExportEntry;
}): string[] {
  const candidates = options.entry.targets.flatMap((target) =>
    getDeclarationCandidatePath({ ...options, target }),
  );
  return uniqueValues(candidates);
}
