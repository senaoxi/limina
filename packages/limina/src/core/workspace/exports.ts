import {
  type CheckerProjectParseContext,
  normalizeExtensions,
} from '#checkers';
import type { ResolvedLiminaConfig } from '#config/runner';
import type {
  ImportAnalysisContext,
  ImportAnalysisMetricsRecorder,
} from '#core/import-analysis/runner';
import type {
  NamedWorkspacePackage,
  WorkspacePackage,
} from '#core/workspace/actions';
import { isNamedWorkspacePackage } from '#core/workspace/actions';
import {
  candidatePathsForBasePath,
  resolveExistingFilePath,
} from '#utils/module-resolution';
import {
  isPathInsideDirectory,
  normalizeAbsolutePath,
  toPosixPath,
} from '#utils/path';
import { isPlainRecord } from '#utils/values';
import path from 'pathe';
import { glob } from 'tinyglobby';
import type ts from 'typescript';
import {
  compileWorkspaceExportResolutionGroups,
  type WorkspaceExportResolutionGroups,
} from './export-resolution-profiles';

export interface WorkspaceExportsResolutionProfile {
  checkerPresets: CheckerProjectParseContext['checkerPresets'];
  configPath: string;
  extensions: string[];
  options: ts.CompilerOptions;
  resolverConfigPath: string;
}

export interface WorkspacePackageExportResolution {
  hasTypeScriptStableEntry: boolean;
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

type ImportAnalysisMetricMeasurement = Parameters<
  ImportAnalysisMetricsRecorder['record']
>[0];

export interface WorkspaceExportsMetricsRecorder
  extends ImportAnalysisMetricsRecorder {
  record(
    measurement:
      | ImportAnalysisMetricMeasurement
      | {
          readonly count?: number;
          readonly kind?: string;
          readonly name:
            | 'workspace-export-grouped-oxc-execution'
            | 'workspace-export-grouped-typescript-execution'
            | 'workspace-export-oxc-resolution'
            | 'workspace-export-oxc-semantic-profile-count'
            | 'workspace-export-profile-count'
            | 'workspace-export-resolution-request'
            | 'workspace-export-result-expansion'
            | 'workspace-export-typescript-profile-fallback'
            | 'workspace-export-typescript-resolution'
            | 'workspace-export-typescript-semantic-profile-count';
          readonly provider?: string;
        },
  ): void;
}

interface PackageExportEntry {
  hasExplicitExports: boolean;
  isNamedWorkspacePackage: boolean;
  packageDirectory: string;
  packageJsonPath: string;
  packageName: string;
  specifier: string;
  subpath: string;
  targets: readonly string[];
}

interface CollectedPackageExportEntries {
  entries: PackageExportEntry[];
  problems: string[];
}

type PackageExportValue = unknown;

const typeScriptRuntimeModulePattern = /\.(?:cjs|mjs|jsx|js)$/u;
const typeScriptDeclarationModulePattern = /\.d\.(?:cts|mts|ts)$/u;

function resolvePackageDeclarationTarget(
  packageDirectory: string,
  target: string,
): string | null {
  if (path.isAbsolute(target) || target.includes('*')) return null;
  const basePath = normalizeAbsolutePath(
    path.resolve(packageDirectory, target),
  );

  if (!isPathInsideDirectory(basePath, packageDirectory)) return null;

  const resolved = candidatePathsForBasePath(basePath, [
    '.d.ts',
    '.d.mts',
    '.d.cts',
  ])
    .map(resolveExistingFilePath)
    .find((candidate): candidate is string => Boolean(candidate));
  return resolved && typeScriptDeclarationModulePattern.test(resolved)
    ? normalizeAbsolutePath(resolved)
    : null;
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

  if (isPlainRecord(value)) {
    return Object.values(value).flatMap(collectExportTargets);
  }

  return [];
}

function isNullPackageExport(value: PackageExportValue): boolean {
  return value === null;
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
        hasExplicitExports: true,
        isNamedWorkspacePackage: true,
        packageDirectory: options.packageDirectory,
        packageJsonPath: path.join(options.packageDirectory, 'package.json'),
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
  workspacePackage: NamedWorkspacePackage,
): Promise<CollectedPackageExportEntries> {
  const exportsField = workspacePackage.manifest.exports;
  const problems: string[] = [];
  const rawEntries: {
    subpath: string;
    value: PackageExportValue;
  }[] =
    isPlainRecord(exportsField) && isSubpathExportMap(exportsField)
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
    if (isNullPackageExport(rawEntry.value)) {
      continue;
    }

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
      hasExplicitExports: true,
      isNamedWorkspacePackage: true,
      packageDirectory: workspacePackage.directory,
      packageJsonPath: path.join(workspacePackage.directory, 'package.json'),
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

export async function collectWorkspacePackageDeclarationEntryPaths(
  packages: readonly WorkspacePackage[],
): Promise<Set<string>> {
  const paths = new Set<string>();
  for (const workspacePackage of packages.filter(isNamedWorkspacePackage)) {
    for (const target of [
      workspacePackage.manifest.types,
      workspacePackage.manifest.typings,
    ]) {
      if (typeof target !== 'string') continue;
      const resolved = resolvePackageDeclarationTarget(
        workspacePackage.directory,
        target,
      );
      if (resolved) paths.add(resolved);
    }
    if (workspacePackage.manifest.exports === undefined) continue;
    const collected = await collectPackageExportEntries(workspacePackage);
    for (const entry of collected.entries) {
      for (const target of entry.targets) {
        const resolved = resolvePackageDeclarationTarget(
          workspacePackage.directory,
          target,
        );
        if (resolved) paths.add(resolved);
      }
    }
  }
  return paths;
}

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

function pathMatchesExtension(filePath: string, extensions: string[]): boolean {
  return normalizeExtensions(extensions).some((extension) =>
    filePath.endsWith(extension),
  );
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

    for (const candidatePath of candidatePathsForBasePath(
      targetPath,
      normalizeExtensions(options.extensions),
    )) {
      const resolvedPath = resolveExistingFilePath(candidatePath);

      if (
        resolvedPath &&
        pathMatchesExtension(resolvedPath, options.extensions)
      ) {
        return resolvedPath;
      }
    }
  }

  return null;
}

function resolveTypeScriptExport(options: {
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

function recordWorkspaceExportProfileMetrics(options: {
  groups: WorkspaceExportResolutionGroups;
  metrics: WorkspaceExportsMetricsRecorder;
}): void {
  options.metrics.record({
    count: options.groups.originals.length,
    kind: 'input',
    name: 'workspace-export-profile-count',
    provider: 'workspace-exports',
  });
  options.metrics.record({
    count: options.groups.typescriptGroups.size,
    kind: 'semantic-v1',
    name: 'workspace-export-typescript-semantic-profile-count',
    provider: 'workspace-exports',
  });
  options.metrics.record({
    count: options.groups.oxcGroups.size,
    kind: 'factory-identity-v1',
    name: 'workspace-export-oxc-semantic-profile-count',
    provider: 'workspace-exports',
  });

  const fallbackCounts = new Map<string, number>();

  for (const profile of options.groups.compiledOriginals) {
    if (profile.typescriptFallbackReason) {
      const kind = profile.typescriptFallbackReason.kind;
      fallbackCounts.set(kind, (fallbackCounts.get(kind) ?? 0) + 1);
    }
  }

  for (const [kind, count] of fallbackCounts) {
    options.metrics.record({
      count,
      kind,
      name: 'workspace-export-typescript-profile-fallback',
      provider: 'workspace-exports',
    });
  }
}

function recordGroupedTypeScriptExecution(
  metrics: WorkspaceExportsMetricsRecorder | undefined,
): void {
  metrics?.record({
    kind: 'request',
    name: 'workspace-export-grouped-typescript-execution',
    provider: 'workspace-exports',
  });
}

function recordGroupedOxcExecution(
  metrics: WorkspaceExportsMetricsRecorder | undefined,
): void {
  metrics?.record({
    kind: 'request',
    name: 'workspace-export-grouped-oxc-execution',
    provider: 'workspace-exports',
  });
}

function recordOriginalResultExpansion(
  metrics: WorkspaceExportsMetricsRecorder | undefined,
): void {
  if (!metrics) {
    return;
  }

  metrics.record({
    kind: 'request',
    name: 'workspace-export-resolution-request',
    provider: 'workspace-exports',
  });
  metrics.record({
    kind: 'request',
    name: 'workspace-export-typescript-resolution',
    provider: 'workspace-exports',
  });
  metrics.record({
    kind: 'request',
    name: 'workspace-export-oxc-resolution',
    provider: 'workspace-exports',
  });
  metrics.record({
    kind: 'result',
    name: 'workspace-export-result-expansion',
    provider: 'workspace-exports',
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

function getDisplayPath(
  config: ResolvedLiminaConfig,
  filePath: string,
): string {
  const relativePath = toPosixPath(path.relative(config.rootDir, filePath));

  if (
    relativePath &&
    relativePath !== '..' &&
    !relativePath.startsWith('../') &&
    !path.isAbsolute(relativePath)
  ) {
    return relativePath;
  }

  return toPosixPath(filePath);
}

function uniqueValues(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function formatExportTargets(targets: readonly string[]): string[] {
  return uniqueValues(targets);
}

function getRuntimeCandidatePaths(options: {
  config: ResolvedLiminaConfig;
  entry: PackageExportEntry;
}): string[] {
  return uniqueValues(
    options.entry.targets.flatMap((target) => {
      if (!target.startsWith('./') || !/\.(?:cjs|mjs|js)$/u.test(target)) {
        return [];
      }

      return [
        getDisplayPath(
          options.config,
          path.resolve(options.entry.packageDirectory, stripDotSlash(target)),
        ),
      ];
    }),
  );
}

function getDeclarationCandidateForRuntimeTarget(
  target: string,
): string | null {
  if (target.endsWith('.mjs')) {
    return `${target.slice(0, -'.mjs'.length)}.d.mts`;
  }

  if (target.endsWith('.cjs')) {
    return `${target.slice(0, -'.cjs'.length)}.d.cts`;
  }

  if (target.endsWith('.js')) {
    return `${target.slice(0, -'.js'.length)}.d.ts`;
  }

  if (typeScriptDeclarationModulePattern.test(target)) {
    return target;
  }

  return null;
}

function getDeclarationCandidatePaths(options: {
  config: ResolvedLiminaConfig;
  entry: PackageExportEntry;
}): string[] {
  return uniqueValues(
    options.entry.targets.flatMap((target) => {
      if (!target.startsWith('./')) {
        return [];
      }

      const declarationTarget = getDeclarationCandidateForRuntimeTarget(target);

      if (!declarationTarget) {
        return [];
      }

      return [
        getDisplayPath(
          options.config,
          path.resolve(
            options.entry.packageDirectory,
            stripDotSlash(declarationTarget),
          ),
        ),
      ];
    }),
  );
}

function addProblemList(
  lines: string[],
  label: string,
  values: readonly string[],
): void {
  lines.push(`  ${label}:`);

  for (const value of values.length > 0 ? values : ['<none>']) {
    lines.push(`    - ${value}`);
  }
}

function formatCheckedProfile(
  config: ResolvedLiminaConfig,
  profile: WorkspaceExportsResolutionProfile,
): string {
  const configPath = getDisplayPath(config, profile.configPath);
  const checkerPresets = profile.checkerPresets.join(', ');

  return checkerPresets ? `${configPath} (${checkerPresets})` : configPath;
}

function getWorkspaceExportFix(): string {
  return 'either create the missing exported entry, or update/remove package.json main/types/exports so the package public surface matches the files that are actually built.';
}

function createWorkspaceExportProblem(options: {
  config: ResolvedLiminaConfig;
  entry: PackageExportEntry;
  expectedCandidates: readonly string[];
  expectedCandidatesLabel: string;
  profiles: readonly WorkspaceExportsResolutionProfile[];
  reason: string;
  resolver: string;
  title: string;
}): string {
  const lines = [
    options.title,
    '  check: graph:check workspace exports preflight',
    `  package: ${options.entry.packageName}`,
    `  package.json: ${getDisplayPath(options.config, options.entry.packageJsonPath)}`,
    `  export: ${options.entry.subpath}`,
    `  specifier: ${options.entry.specifier}`,
  ];

  addProblemList(
    lines,
    'declared targets',
    formatExportTargets(options.entry.targets),
  );
  lines.push(`  resolver: ${options.resolver}`);
  addProblemList(
    lines,
    'checked profiles',
    options.profiles.map((profile) =>
      formatCheckedProfile(options.config, profile),
    ),
  );

  if (options.expectedCandidates.length > 0) {
    addProblemList(
      lines,
      options.expectedCandidatesLabel,
      options.expectedCandidates,
    );
  }

  lines.push(
    `  reason: ${options.reason}`,
    `  fix: ${getWorkspaceExportFix()}`,
  );

  return lines.join('\n');
}

function addEntryProblems(options: {
  config: ResolvedLiminaConfig;
  entry: PackageExportEntry;
  oxcResolvedPaths: string[];
  problems: string[];
  profiles: readonly WorkspaceExportsResolutionProfile[];
  typeScriptResolvedPaths: string[];
}): void {
  if (
    options.typeScriptResolvedPaths.length === 0 &&
    options.oxcResolvedPaths.length === 0
  ) {
    options.problems.push(
      createWorkspaceExportProblem({
        config: options.config,
        entry: options.entry,
        expectedCandidates: getDeclarationCandidatePaths({
          config: options.config,
          entry: options.entry,
        }),
        expectedCandidatesLabel: 'expected declaration candidates',
        profiles: options.profiles,
        reason:
          'package.json#exports/types/main do not resolve to a declaration entry for any active checker profile.',
        resolver: 'TypeScript declaration resolver',
        title:
          'Workspace package export has no TypeScript declaration-context resolution',
      }),
    );
  }

  if (options.oxcResolvedPaths.length === 0) {
    options.problems.push(
      createWorkspaceExportProblem({
        config: options.config,
        entry: options.entry,
        expectedCandidates: getRuntimeCandidatePaths({
          config: options.config,
          entry: options.entry,
        }),
        expectedCandidatesLabel: 'expected runtime candidates',
        profiles: options.profiles,
        reason:
          'package.json#exports declares this public entry, but no active checker profile can resolve it.',
        resolver: 'Oxc runtime resolver',
        title: 'Workspace package export points to an unresolved public entry',
      }),
    );
  }
}

export async function createWorkspaceExportsResolutionIndex(options: {
  config: ResolvedLiminaConfig;
  importAnalysis: ImportAnalysisContext;
  metrics?: WorkspaceExportsMetricsRecorder;
  packages: WorkspacePackage[];
  profiles: WorkspaceExportsResolutionProfile[];
}): Promise<WorkspaceExportsResolutionIndex> {
  const packagesWithExports = new Set<string>();
  const problems: string[] = [];
  const resolutionByProfilePath = new Map<
    string,
    Map<string, WorkspacePackageExportResolution>
  >();
  const groups = compileWorkspaceExportResolutionGroups(options.profiles);

  if (options.metrics) {
    recordWorkspaceExportProfileMetrics({
      groups,
      metrics: options.metrics,
    });
  }

  for (const workspacePackage of options.packages.filter(
    isNamedWorkspacePackage,
  )) {
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

      for (const profile of options.profiles) {
        recordGroupedTypeScriptExecution(options.metrics);
        const typeScriptResolvedFileName = resolveTypeScriptExport({
          entry,
          importAnalysis: options.importAnalysis,
          profile,
        });
        recordGroupedOxcExecution(options.metrics);
        const rawOxcResolvedFileName = resolveOxcExport({
          entry,
          importAnalysis: options.importAnalysis,
          profile,
        });
        recordOriginalResultExpansion(options.metrics);
        // Keep the raw runtime resolver result separate from the effective
        // value: pure type exports intentionally fall back to the TS result.
        const oxcResolvedFileName = getEffectiveOxcResolvedFileName({
          oxcResolvedFileName: rawOxcResolvedFileName,
          typeScriptResolvedFileName,
        });
        const profileResolutions =
          resolutionByProfilePath.get(profile.configPath) ?? new Map();

        profileResolutions.set(entry.specifier, {
          hasTypeScriptStableEntry: Boolean(
            typeScriptResolvedFileName &&
              !typeScriptRuntimeModulePattern.test(typeScriptResolvedFileName),
          ),
          oxcResolvedFileName,
          packageName: entry.packageName,
          specifier: entry.specifier,
          subpath: entry.subpath,
          typeScriptResolvedFileName,
        });
        resolutionByProfilePath.set(profile.configPath, profileResolutions);

        if (typeScriptResolvedFileName) {
          typeScriptResolvedPaths.push(typeScriptResolvedFileName);
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
        profiles: options.profiles,
        typeScriptResolvedPaths,
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
