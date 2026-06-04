import { existsSync, statSync } from 'node:fs';
import path from 'pathe';
import { glob } from 'tinyglobby';
import type ts from 'typescript';
import {
  type CheckerProjectParseContext,
  normalizeExtensions,
  resolveModuleNameWithCheckers,
} from './checkers';
import type { ResolvedLiminaConfig } from './config';
import { resolveModuleNameWithOxc } from './import-analysis';
import {
  normalizeAbsolutePath,
  toPosixPath,
  toRelativePath,
} from './utils/path';
import type { WorkspacePackage } from './workspace';

export interface WorkspaceExportsResolutionProfile {
  checkerPresets: CheckerProjectParseContext['checkerPresets'];
  configPath: string;
  extensions: string[];
  options: ts.CompilerOptions;
}

export interface WorkspacePackageExportResolution {
  oxcResolvedFileName: string | null;
  packageName: string;
  specifier: string;
  subpath: string;
  typeScriptResolvedFileName: string | null;
}

export interface WorkspaceExportsResolutionIndex {
  get: (
    profileConfigPath: string,
    specifier: string,
  ) => WorkspacePackageExportResolution | null;
  hasExports: (packageName: string) => boolean;
  problems: string[];
}

interface PackageExportEntry {
  packageDirectory: string;
  packageName: string;
  specifier: string;
  subpath: string;
  targets: string[];
}

interface CollectedPackageExportEntries {
  entries: PackageExportEntry[];
  problems: string[];
}

type PackageExportValue = unknown;

const typeScriptRuntimeModulePattern = /\.(?:cjs|mjs|jsx|js)$/u;
const typeScriptDeclarationModulePattern = /\.d\.(?:cts|mts|ts)$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSubpathExportMap(exportsField: Record<string, unknown>): boolean {
  return Object.keys(exportsField).some(
    (key) => key === '.' || key.startsWith('./'),
  );
}

function getSpecifierForSubpath(packageName: string, subpath: string): string {
  return subpath === '.'
    ? packageName
    : `${packageName}/${subpath.slice('./'.length)}`;
}

function collectExportTargets(value: PackageExportValue): string[] {
  if (typeof value === 'string') {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.flatMap(collectExportTargets);
  }

  if (isRecord(value)) {
    return Object.values(value).flatMap(collectExportTargets);
  }

  return [];
}

function stripDotSlash(value: string): string {
  return value.startsWith('./') ? value.slice('./'.length) : value;
}

function replaceFirstWildcard(pattern: string, value: string): string {
  const wildcardIndex = pattern.indexOf('*');

  return wildcardIndex === -1
    ? pattern
    : `${pattern.slice(0, wildcardIndex)}${value}${pattern.slice(wildcardIndex + 1)}`;
}

function getWildcardTextFromMatchedTarget(options: {
  matchedPath: string;
  targetPattern: string;
}): string | null {
  const pattern = stripDotSlash(options.targetPattern);
  const wildcardIndex = pattern.indexOf('*');

  if (wildcardIndex === -1) {
    return null;
  }

  const prefix = pattern.slice(0, wildcardIndex);
  const suffix = pattern.slice(wildcardIndex + 1);

  if (
    !options.matchedPath.startsWith(prefix) ||
    !options.matchedPath.endsWith(suffix)
  ) {
    return null;
  }

  return options.matchedPath.slice(
    prefix.length,
    options.matchedPath.length - suffix.length,
  );
}

function getExportEntryTargetsForWildcard(
  targets: string[],
  wildcardText: string,
): string[] {
  return targets.map((target) => replaceFirstWildcard(target, wildcardText));
}

async function expandWildcardExportEntry(options: {
  packageDirectory: string;
  packageName: string;
  subpath: string;
  targets: string[];
}): Promise<CollectedPackageExportEntries> {
  const entries = new Map<string, PackageExportEntry>();
  const problems: string[] = [];
  const wildcardTargets = options.targets.filter((target) =>
    target.includes('*'),
  );

  if (wildcardTargets.length === 0) {
    problems.push(
      [
        'Unable to expand wildcard package export:',
        `  package: ${options.packageName}`,
        `  export: ${options.subpath}`,
        '  reason: wildcard exports must have at least one string target containing "*".',
      ].join('\n'),
    );
    return {
      entries: [],
      problems,
    };
  }

  for (const targetPattern of wildcardTargets) {
    if (!targetPattern.startsWith('./')) {
      continue;
    }

    const matches = await glob(stripDotSlash(targetPattern), {
      absolute: false,
      cwd: options.packageDirectory,
      dot: true,
      onlyFiles: true,
    });

    for (const rawMatchedPath of matches) {
      const matchedPath = toPosixPath(rawMatchedPath);
      const wildcardText = getWildcardTextFromMatchedTarget({
        matchedPath,
        targetPattern,
      });

      if (wildcardText === null) {
        continue;
      }

      const subpath = replaceFirstWildcard(options.subpath, wildcardText);
      const specifier = getSpecifierForSubpath(options.packageName, subpath);

      entries.set(specifier, {
        packageDirectory: options.packageDirectory,
        packageName: options.packageName,
        specifier,
        subpath,
        targets: getExportEntryTargetsForWildcard(
          options.targets,
          wildcardText,
        ),
      });
    }
  }

  if (entries.size === 0) {
    problems.push(
      [
        'Unable to expand wildcard package export:',
        `  package: ${options.packageName}`,
        `  export: ${options.subpath}`,
        '  reason: no concrete files matched the export target patterns.',
      ].join('\n'),
    );
  }

  return {
    entries: [...entries.values()].sort((left, right) =>
      left.specifier.localeCompare(right.specifier),
    ),
    problems,
  };
}

async function collectPackageExportEntries(
  workspacePackage: WorkspacePackage,
): Promise<CollectedPackageExportEntries> {
  const exportsField = workspacePackage.manifest.exports;
  const problems: string[] = [];
  const rawEntries: {
    subpath: string;
    value: PackageExportValue;
  }[] =
    isRecord(exportsField) && isSubpathExportMap(exportsField)
      ? Object.entries(exportsField)
          .filter(([subpath]) => subpath === '.' || subpath.startsWith('./'))
          .map(([subpath, value]) => ({
            subpath,
            value,
          }))
      : [
          {
            subpath: '.',
            value: exportsField,
          },
        ];
  const entries: PackageExportEntry[] = [];

  for (const rawEntry of rawEntries) {
    const targets = collectExportTargets(rawEntry.value);

    if (rawEntry.subpath.includes('*')) {
      const expanded = await expandWildcardExportEntry({
        packageDirectory: workspacePackage.directory,
        packageName: workspacePackage.name,
        subpath: rawEntry.subpath,
        targets,
      });

      entries.push(...expanded.entries);
      problems.push(...expanded.problems);
      continue;
    }

    entries.push({
      packageDirectory: workspacePackage.directory,
      packageName: workspacePackage.name,
      specifier: getSpecifierForSubpath(
        workspacePackage.name,
        rawEntry.subpath,
      ),
      subpath: rawEntry.subpath,
      targets,
    });
  }

  return {
    entries: entries.sort((left, right) =>
      left.specifier.localeCompare(right.specifier),
    ),
    problems,
  };
}

function getProfileContext(
  profile: WorkspaceExportsResolutionProfile,
): CheckerProjectParseContext {
  return {
    checkerPresets: profile.checkerPresets,
    extensions: profile.extensions,
  };
}

function pathMatchesExtension(filePath: string, extensions: string[]): boolean {
  return normalizeExtensions(extensions).some((extension) =>
    filePath.endsWith(extension),
  );
}

function resolveCandidatePath(candidatePath: string): string | null {
  if (!existsSync(candidatePath)) {
    return null;
  }

  if (!statSync(candidatePath).isFile()) {
    return null;
  }

  return normalizeAbsolutePath(candidatePath);
}

function resolveTargetWithCheckerExtensions(options: {
  entry: PackageExportEntry;
  extensions: string[];
}): string | null {
  for (const target of options.entry.targets) {
    if (!target.startsWith('./')) {
      continue;
    }

    const targetPath = path.resolve(
      options.entry.packageDirectory,
      stripDotSlash(target),
    );

    if (path.extname(targetPath)) {
      const resolvedPath = resolveCandidatePath(targetPath);

      if (
        resolvedPath &&
        pathMatchesExtension(resolvedPath, options.extensions)
      ) {
        return resolvedPath;
      }

      continue;
    }

    for (const extension of normalizeExtensions(options.extensions)) {
      for (const candidatePath of [
        `${targetPath}${extension}`,
        path.join(targetPath, `index${extension}`),
      ]) {
        const resolvedPath = resolveCandidatePath(candidatePath);

        if (resolvedPath) {
          return resolvedPath;
        }
      }
    }
  }

  return null;
}

function resolveTypeScriptExport(options: {
  entry: PackageExportEntry;
  profile: WorkspaceExportsResolutionProfile;
}): string | null {
  const containingFile = path.join(
    options.entry.packageDirectory,
    'package.json',
  );
  const resolved = resolveModuleNameWithCheckers({
    compilerOptions: options.profile.options,
    containingFile,
    context: getProfileContext(options.profile),
    specifier: options.entry.specifier,
  });

  return (
    resolved ??
    resolveTargetWithCheckerExtensions({
      entry: options.entry,
      extensions: options.profile.extensions,
    })
  );
}

function resolveOxcExport(options: {
  entry: PackageExportEntry;
  profile: WorkspaceExportsResolutionProfile;
}): string | null {
  return resolveModuleNameWithOxc({
    compilerOptions: options.profile.options,
    containingFile: path.join(options.entry.packageDirectory, 'package.json'),
    context: getProfileContext(options.profile),
    specifier: options.entry.specifier,
  });
}

function getEffectiveOxcResolvedFileName(options: {
  oxcResolvedFileName: string | null;
  typeScriptResolvedFileName: string | null;
}): string | null {
  if (options.oxcResolvedFileName) {
    return options.oxcResolvedFileName;
  }

  // A declaration-only export has no runtime branch for Oxc to choose.
  // When TypeScript can still resolve it to a .d.ts family file, treat that
  // declaration as the effective Oxc result so later graph code can keep using
  // one resolved path without flagging pure type entrypoints as missing.
  if (
    options.typeScriptResolvedFileName &&
    typeScriptDeclarationModulePattern.test(options.typeScriptResolvedFileName)
  ) {
    return options.typeScriptResolvedFileName;
  }

  return null;
}

function formatProfile(
  config: ResolvedLiminaConfig,
  configPath: string,
): string {
  return toRelativePath(config.rootDir, configPath);
}

function addEntryProblems(options: {
  config: ResolvedLiminaConfig;
  entry: PackageExportEntry;
  oxcResolvedPaths: string[];
  problems: string[];
  typeScriptRuntimeResolutions: {
    configPath: string;
    resolvedFileName: string;
  }[];
  typeScriptResolvedPaths: string[];
}): void {
  if (options.typeScriptResolvedPaths.length === 0) {
    options.problems.push(
      [
        'Workspace package export is not resolvable by TypeScript:',
        `  package: ${options.entry.packageName}`,
        `  export: ${options.entry.subpath}`,
        `  specifier: ${options.entry.specifier}`,
        '  reason: no active checker profile could resolve this package export in the TypeScript declaration context.',
      ].join('\n'),
    );
  }

  if (options.oxcResolvedPaths.length === 0) {
    options.problems.push(
      [
        'Workspace package export is not resolvable by Oxc:',
        `  package: ${options.entry.packageName}`,
        `  export: ${options.entry.subpath}`,
        `  specifier: ${options.entry.specifier}`,
        '  reason: no active checker profile could resolve this package export through the runtime resolver.',
      ].join('\n'),
    );
  }

  for (const resolution of options.typeScriptRuntimeResolutions) {
    options.problems.push(
      [
        'Workspace package export resolves to runtime JavaScript in TypeScript:',
        `  package: ${options.entry.packageName}`,
        `  export: ${options.entry.subpath}`,
        `  specifier: ${options.entry.specifier}`,
        `  profile: ${formatProfile(options.config, resolution.configPath)}`,
        `  resolved file: ${toRelativePath(options.config.rootDir, resolution.resolvedFileName)}`,
        '  reason: TypeScript resolved the export to a runtime module instead of a stable type or checker source entry.',
      ].join('\n'),
    );
  }
}

export async function createWorkspaceExportsResolutionIndex(options: {
  config: ResolvedLiminaConfig;
  packages: WorkspacePackage[];
  profiles: WorkspaceExportsResolutionProfile[];
}): Promise<WorkspaceExportsResolutionIndex> {
  const packagesWithExports = new Set<string>();
  const problems: string[] = [];
  const resolutionByProfilePath = new Map<
    string,
    Map<string, WorkspacePackageExportResolution>
  >();

  for (const workspacePackage of options.packages) {
    if (workspacePackage.manifest.exports === undefined) {
      continue;
    }

    packagesWithExports.add(workspacePackage.name);

    const collectedEntries =
      await collectPackageExportEntries(workspacePackage);

    problems.push(...collectedEntries.problems);

    for (const entry of collectedEntries.entries) {
      const typeScriptResolvedPaths: string[] = [];
      const oxcResolvedPaths: string[] = [];
      const typeScriptRuntimeResolutions: {
        configPath: string;
        resolvedFileName: string;
      }[] = [];

      for (const profile of options.profiles) {
        const typeScriptResolvedFileName = resolveTypeScriptExport({
          entry,
          profile,
        });
        const rawOxcResolvedFileName = resolveOxcExport({
          entry,
          profile,
        });
        // Keep the raw runtime resolver result separate from the effective
        // value: pure type exports intentionally fall back to the TS result.
        const oxcResolvedFileName = getEffectiveOxcResolvedFileName({
          oxcResolvedFileName: rawOxcResolvedFileName,
          typeScriptResolvedFileName,
        });
        const profileResolutions =
          resolutionByProfilePath.get(profile.configPath) ?? new Map();

        profileResolutions.set(entry.specifier, {
          oxcResolvedFileName,
          packageName: entry.packageName,
          specifier: entry.specifier,
          subpath: entry.subpath,
          typeScriptResolvedFileName,
        });
        resolutionByProfilePath.set(profile.configPath, profileResolutions);

        if (typeScriptResolvedFileName) {
          typeScriptResolvedPaths.push(typeScriptResolvedFileName);

          if (typeScriptRuntimeModulePattern.test(typeScriptResolvedFileName)) {
            typeScriptRuntimeResolutions.push({
              configPath: profile.configPath,
              resolvedFileName: typeScriptResolvedFileName,
            });
          }
        }

        if (oxcResolvedFileName) {
          oxcResolvedPaths.push(oxcResolvedFileName);
        }
      }

      addEntryProblems({
        config: options.config,
        entry,
        oxcResolvedPaths,
        problems,
        typeScriptResolvedPaths,
        typeScriptRuntimeResolutions,
      });
    }
  }

  return {
    get: (profileConfigPath, specifier) =>
      resolutionByProfilePath.get(profileConfigPath)?.get(specifier) ?? null,
    hasExports: (packageName) => packagesWithExports.has(packageName),
    problems,
  };
}
