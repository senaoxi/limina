import {
  isNamedWorkspacePackage,
  type NamedWorkspacePackage,
  type WorkspacePackage,
} from '#core/workspace/actions';
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

interface WorkspaceExportProblem {
  readonly detailLines: readonly string[];
  readonly fix?: string;
  readonly packageJsonPath: string;
  readonly packageName: string;
  readonly reason: string;
  readonly subpath: string;
  readonly title: string;
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
  diagnostics: WorkspaceExportProblem[];
  entries: PackageExportEntry[];
  problems: string[];
}

type PackageExportValue = unknown;

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

function collectNestedExportTargets(value: PackageExportValue): string[] {
  if (Array.isArray(value)) return value.flatMap(collectExportTargets);
  return isPlainRecord(value)
    ? Object.values(value).flatMap(collectExportTargets)
    : [];
}

function collectExportTargets(value: PackageExportValue): string[] {
  return typeof value === 'string'
    ? [value]
    : collectNestedExportTargets(value);
}

function isNullPackageExport(value: PackageExportValue): boolean {
  return value === null;
}

function stripDotSlash(value: string): string {
  return value.startsWith('./') ? value.slice('./'.length) : value;
}

function replaceWildcards(pattern: string, value: string): string {
  return pattern.split('*').join(value);
}

function getWildcardTextFromMatchedTarget(options: {
  matchedPath: string;
  targetPattern: string;
}): string | null {
  const pattern = stripDotSlash(options.targetPattern);
  const parts = pattern.split('*');
  const literalLength = parts.reduce((total, part) => total + part.length, 0);
  const captureLength =
    (options.matchedPath.length - literalLength) / (parts.length - 1);
  if (captureLength <= 0) return null;
  const start = parts[0]!.length;
  const capture = options.matchedPath.slice(start, start + captureLength);
  return replaceWildcards(pattern, capture) === options.matchedPath
    ? capture
    : null;
}

function getExportEntryTargetsForWildcard(
  targets: readonly string[],
  wildcardText: string,
): string[] {
  return targets.map((target) => replaceWildcards(target, wildcardText));
}

function createWildcardProblem(options: {
  packageDirectory: string;
  packageName: string;
  reason: string;
  subpath: string;
}): { diagnostic: WorkspaceExportProblem; problem: string } {
  const detailLines = [
    'Unable to expand wildcard package export:',
    `  package: ${options.packageName}`,
    `  export: ${options.subpath}`,
    `  reason: ${options.reason}`,
  ];
  return {
    diagnostic: {
      detailLines,
      packageJsonPath: path.join(options.packageDirectory, 'package.json'),
      packageName: options.packageName,
      reason: options.reason,
      subpath: options.subpath,
      title: 'Unable to expand wildcard package export',
    },
    problem: detailLines.join('\n'),
  };
}

function createProblemResult(options: {
  packageDirectory: string;
  packageName: string;
  reason: string;
  subpath: string;
}): CollectedPackageExportEntries {
  const problem = createWildcardProblem(options);
  return {
    diagnostics: [problem.diagnostic],
    entries: [],
    problems: [problem.problem],
  };
}

function createWildcardEntry(options: {
  matchedPath: string;
  packageDirectory: string;
  packageName: string;
  subpathPattern: string;
  targetPattern: string;
  targets: readonly string[];
}): PackageExportEntry | null {
  const wildcardText = getWildcardTextFromMatchedTarget({
    matchedPath: options.matchedPath,
    targetPattern: options.targetPattern,
  });
  if (wildcardText === null) return null;
  const subpath = replaceWildcards(options.subpathPattern, wildcardText);
  return {
    hasExplicitExports: true,
    isNamedWorkspacePackage: true,
    packageDirectory: options.packageDirectory,
    packageJsonPath: path.join(options.packageDirectory, 'package.json'),
    packageName: options.packageName,
    specifier: getSpecifierForSubpath(options.packageName, subpath),
    subpath,
    targets: getExportEntryTargetsForWildcard(options.targets, wildcardText),
  };
}

function expandTargetPattern(options: {
  files: readonly string[];
  packageDirectory: string;
  packageName: string;
  subpath: string;
  targetPattern: string;
  targets: readonly string[];
}): PackageExportEntry[] {
  if (!options.targetPattern.startsWith('./')) return [];
  return options.files
    .map((rawMatchedPath) =>
      createWildcardEntry({
        matchedPath: toPosixPath(rawMatchedPath),
        packageDirectory: options.packageDirectory,
        packageName: options.packageName,
        subpathPattern: options.subpath,
        targetPattern: options.targetPattern,
        targets: options.targets,
      }),
    )
    .filter((entry): entry is PackageExportEntry => entry !== null);
}

function compareEntries(
  left: PackageExportEntry,
  right: PackageExportEntry,
): number {
  return left.specifier.localeCompare(right.specifier);
}

function deduplicateEntries(
  entries: readonly PackageExportEntry[],
): PackageExportEntry[] {
  const bySpecifier = new Map(
    entries.map((entry) => [entry.specifier, entry] as const),
  );
  return bySpecifier.values().toArray().sort(compareEntries);
}

async function expandWildcardExportEntry(options: {
  packageDirectory: string;
  packageName: string;
  subpath: string;
  targets: readonly string[];
}): Promise<CollectedPackageExportEntries> {
  const wildcardTargets = options.targets.filter((target) =>
    target.includes('*'),
  );
  if (wildcardTargets.length === 0) {
    return createProblemResult({
      ...options,
      reason:
        'wildcard exports must have at least one string target containing "*".',
    });
  }
  const files = await glob('**/*', {
    absolute: false,
    cwd: options.packageDirectory,
    dot: true,
    ignore: ['**/node_modules/**'],
    onlyFiles: true,
  });
  const expanded = wildcardTargets.map((targetPattern) =>
    expandTargetPattern({ ...options, files, targetPattern }),
  );
  const entries = deduplicateEntries(expanded.flat());
  if (entries.length > 0) return { diagnostics: [], entries, problems: [] };
  return createProblemResult({
    ...options,
    reason: 'no concrete files matched the export target patterns.',
  });
}

interface RawExportEntry {
  subpath: string;
  value: unknown;
}

function isExportSubpath(subpath: string): boolean {
  return subpath === '.' || subpath.startsWith('./');
}

function getSubpathEntries(
  exportsField: Record<string, unknown>,
): RawExportEntry[] {
  return Object.entries(exportsField)
    .filter(([subpath]) => isExportSubpath(subpath))
    .map(([subpath, value]) => ({ subpath, value }));
}

function getRawExportEntries(exportsField: unknown): RawExportEntry[] {
  return isPlainRecord(exportsField) && isSubpathExportMap(exportsField)
    ? getSubpathEntries(exportsField)
    : [{ subpath: '.', value: exportsField }];
}

function createConcreteExportEntry(options: {
  subpath: string;
  targets: readonly string[];
  workspacePackage: NamedWorkspacePackage;
}): PackageExportEntry {
  return {
    hasExplicitExports: true,
    isNamedWorkspacePackage: true,
    packageDirectory: options.workspacePackage.directory,
    packageJsonPath: path.join(
      options.workspacePackage.directory,
      'package.json',
    ),
    packageName: options.workspacePackage.name,
    specifier: getSpecifierForSubpath(
      options.workspacePackage.name,
      options.subpath,
    ),
    subpath: options.subpath,
    targets: options.targets,
  };
}

function createEmptyCollection(): CollectedPackageExportEntries {
  return { diagnostics: [], entries: [], problems: [] };
}

async function collectRawExportEntry(options: {
  rawEntry: RawExportEntry;
  workspacePackage: NamedWorkspacePackage;
}): Promise<CollectedPackageExportEntries> {
  if (isNullPackageExport(options.rawEntry.value)) {
    return createEmptyCollection();
  }
  const targets = collectExportTargets(options.rawEntry.value);
  if (options.rawEntry.subpath.includes('*')) {
    return expandWildcardExportEntry({
      packageDirectory: options.workspacePackage.directory,
      packageName: options.workspacePackage.name,
      subpath: options.rawEntry.subpath,
      targets,
    });
  }
  return {
    diagnostics: [],
    entries: [
      createConcreteExportEntry({
        subpath: options.rawEntry.subpath,
        targets,
        workspacePackage: options.workspacePackage,
      }),
    ],
    problems: [],
  };
}

function mergeCollections(
  collections: readonly CollectedPackageExportEntries[],
): CollectedPackageExportEntries {
  return {
    diagnostics: collections.flatMap((collection) => collection.diagnostics),
    entries: collections
      .flatMap((collection) => collection.entries)
      .sort(compareEntries),
    problems: collections.flatMap((collection) => collection.problems),
  };
}

export async function collectPackageExportEntries(
  workspacePackage: NamedWorkspacePackage,
): Promise<CollectedPackageExportEntries> {
  const rawEntries = getRawExportEntries(workspacePackage.manifest.exports);
  const collections = await Promise.all(
    rawEntries.map((rawEntry) =>
      collectRawExportEntry({ rawEntry, workspacePackage }),
    ),
  );
  return mergeCollections(collections);
}

const declarationModulePattern = /\.d\.(?:cts|mts|ts)$/u;

const declarationExtensions = ['.d.ts', '.d.mts', '.d.cts'] as const;

function isResolvableDeclarationTarget(target: string): boolean {
  return !path.isAbsolute(target) && !target.includes('*');
}

function findDeclarationCandidate(basePath: string): string | undefined {
  return candidatePathsForBasePath(basePath, [...declarationExtensions])
    .map(resolveExistingFilePath)
    .find((candidate): candidate is string => candidate !== null);
}

function normalizeDeclarationCandidate(
  candidate: string | undefined,
): string | null {
  return candidate === undefined || !declarationModulePattern.test(candidate)
    ? null
    : normalizeAbsolutePath(candidate);
}

function resolvePackageDeclarationTarget(
  packageDirectory: string,
  target: string,
): string | null {
  if (!isResolvableDeclarationTarget(target)) return null;
  const basePath = normalizeAbsolutePath(
    path.resolve(packageDirectory, target),
  );
  return isPathInsideDirectory(basePath, packageDirectory)
    ? normalizeDeclarationCandidate(findDeclarationCandidate(basePath))
    : null;
}

function resolveDeclarationTargets(
  packageDirectory: string,
  targets: readonly unknown[],
): string[] {
  return targets
    .filter((target): target is string => typeof target === 'string')
    .map((target) => resolvePackageDeclarationTarget(packageDirectory, target))
    .filter((target): target is string => target !== null);
}

function getManifestDeclarationTargets(
  workspacePackage: NamedWorkspacePackage,
): unknown[] {
  return [workspacePackage.manifest.types, workspacePackage.manifest.typings];
}

async function collectExportDeclarationTargets(
  workspacePackage: NamedWorkspacePackage,
): Promise<string[]> {
  if (workspacePackage.manifest.exports === undefined) return [];
  const collected = await collectPackageExportEntries(workspacePackage);
  return resolveDeclarationTargets(
    workspacePackage.directory,
    collected.entries.flatMap((entry) => entry.targets),
  );
}

async function collectPackageDeclarationTargets(
  workspacePackage: NamedWorkspacePackage,
): Promise<string[]> {
  const direct = resolveDeclarationTargets(
    workspacePackage.directory,
    getManifestDeclarationTargets(workspacePackage),
  );
  const exported = await collectExportDeclarationTargets(workspacePackage);
  return [...direct, ...exported];
}

export async function collectWorkspacePackageDeclarationEntryPaths(
  packages: readonly WorkspacePackage[],
): Promise<Set<string>> {
  const namedPackages = packages.filter(isNamedWorkspacePackage);
  const paths = await Promise.all(
    namedPackages.map(collectPackageDeclarationTargets),
  );
  return new Set(paths.flat());
}
