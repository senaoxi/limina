import { toPosixPath } from '#utils/path';
import { isPlainRecord } from '#utils/values';
import path from 'pathe';
import { glob } from 'tinyglobby';
import type {
  CollectedPackageExportEntries,
  PackageExportEntry,
  WorkspaceExportProblem,
} from './types';

type PackageExportValue = unknown;

export function isSubpathExportMap(
  exportsField: Record<string, unknown>,
): boolean {
  return Object.keys(exportsField).some(
    (key) => key === '.' || key.startsWith('./'),
  );
}

export function getSpecifierForSubpath(
  packageName: string,
  subpath: string,
): string {
  return subpath === '.'
    ? packageName
    : `${packageName}/${subpath.slice('./'.length)}`;
}

function collectNestedExportTargets(value: PackageExportValue): string[] {
  if (Array.isArray(value)) return value.flatMap(collectExportTargets);
  if (isPlainRecord(value)) {
    return Object.values(value).flatMap(collectExportTargets);
  }
  return [];
}

export function collectExportTargets(value: PackageExportValue): string[] {
  if (typeof value === 'string') return [value];
  return collectNestedExportTargets(value);
}

export function isNullPackageExport(value: PackageExportValue): boolean {
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
  return [...bySpecifier.values()].sort(compareEntries);
}

export async function expandWildcardExportEntry(options: {
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
