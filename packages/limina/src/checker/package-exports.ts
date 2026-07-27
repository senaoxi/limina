import {
  candidatePathsForBasePath,
  resolveExistingFilePath,
} from '#utils/module-resolution';
import { existsSync, readFileSync } from 'node:fs';
import path from 'pathe';

interface PackageSpecifierParts {
  packageName: string;
  subpath: string;
}

function isLocalSpecifier(specifier: string): boolean {
  if (specifier.length === 0) return true;
  if (specifier.startsWith('.')) return true;
  return specifier.startsWith('/');
}

function createSubpath(parts: string[], startIndex: number): string {
  if (parts.length <= startIndex) return '.';
  return `./${parts.slice(startIndex).join('/')}`;
}

function parseScopedPackageSpecifier(
  parts: string[],
): PackageSpecifierParts | null {
  const scope = parts[0];
  const name = parts[1];
  if (scope === undefined) return null;
  if (name === undefined) return null;
  return {
    packageName: `${scope}/${name}`,
    subpath: createSubpath(parts, 2),
  };
}

function parseUnscopedPackageSpecifier(
  parts: string[],
): PackageSpecifierParts | null {
  const packageName = parts[0];
  if (packageName === undefined) return null;
  return { packageName, subpath: createSubpath(parts, 1) };
}

function parsePackageSpecifier(
  specifier: string,
): PackageSpecifierParts | null {
  if (isLocalSpecifier(specifier)) return null;
  const parts = specifier.split('/');
  return specifier.startsWith('@')
    ? parseScopedPackageSpecifier(parts)
    : parseUnscopedPackageSpecifier(parts);
}

function getPackageDirectory(options: {
  currentDir: string;
  packageName: string;
}): string | null {
  const packageDirectory = path.join(
    options.currentDir,
    'node_modules',
    options.packageName,
  );
  return existsSync(path.join(packageDirectory, 'package.json'))
    ? packageDirectory
    : null;
}

function collectAncestorDirectories(startDirectory: string): string[] {
  const directories: string[] = [];
  let currentDirectory = startDirectory;
  while (true) {
    directories.push(currentDirectory);
    const parentDirectory = path.dirname(currentDirectory);
    if (parentDirectory === currentDirectory) return directories;
    currentDirectory = parentDirectory;
  }
}

function findPackageDirectoryForImport(options: {
  containingFile: string;
  packageName: string;
}): string | null {
  const directories = collectAncestorDirectories(
    path.dirname(options.containingFile),
  );
  for (const currentDir of directories) {
    const packageDirectory = getPackageDirectory({
      currentDir,
      packageName: options.packageName,
    });
    if (packageDirectory !== null) return packageDirectory;
  }
  return null;
}

function readPackageManifest(
  packageDirectory: string,
): { exports?: unknown } | null {
  try {
    return JSON.parse(
      readFileSync(path.join(packageDirectory, 'package.json'), 'utf8'),
    ) as { exports?: unknown };
  } catch {
    return null;
  }
}

function isObject(value: unknown): value is object {
  if (value === null) return false;
  return typeof value === 'object';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!isObject(value)) return false;
  return !Array.isArray(value);
}

function collectArrayTargets(value: readonly unknown[]): string[] {
  return value.flatMap(collectStringTargets);
}

function collectRecordTargets(value: Record<string, unknown>): string[] {
  return Object.values(value).flatMap(collectStringTargets);
}

function collectObjectTargets(value: object): string[] {
  if (Array.isArray(value)) return collectArrayTargets(value);
  return collectRecordTargets(value as Record<string, unknown>);
}

function collectStringTargets(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (!isObject(value)) return [];
  return collectObjectTargets(value);
}

function isSubpathExportKey(key: string): boolean {
  if (key === '.') return true;
  return key.startsWith('./');
}

function hasSubpathExportMap(exportsField: Record<string, unknown>): boolean {
  return Object.keys(exportsField).some(isSubpathExportKey);
}

type DefaultExportCollector = (exportsField: unknown) => string[];

const defaultExportCollectors: Readonly<
  Record<string, DefaultExportCollector>
> = {
  '.': collectStringTargets,
};

function applyDefaultExportCollector(
  collector: DefaultExportCollector | undefined,
  exportsField: unknown,
): string[] {
  if (collector === undefined) return [];
  return collector(exportsField);
}

function collectDefaultExportTargets(
  exportsField: unknown,
  subpath: string,
): string[] {
  const collector = defaultExportCollectors[subpath];
  return applyDefaultExportCollector(collector, exportsField);
}

function collectRecordExportTargets(options: {
  exportsField: Record<string, unknown>;
  subpath: string;
}): string[] {
  if (!hasSubpathExportMap(options.exportsField)) {
    return collectDefaultExportTargets(options.exportsField, options.subpath);
  }
  return collectStringTargets(options.exportsField[options.subpath]);
}

function collectDefinedExportTargets(
  exportsField: unknown,
  subpath: string,
): string[] {
  if (!isRecord(exportsField)) {
    return collectDefaultExportTargets(exportsField, subpath);
  }
  return collectRecordExportTargets({ exportsField, subpath });
}

function collectExportTargetsForSubpath(
  exportsField: unknown,
  subpath: string,
): string[] {
  if (exportsField !== undefined) {
    return collectDefinedExportTargets(exportsField, subpath);
  }
  return subpath === '.' ? ['..'] : [subpath];
}

function resolveCandidatePath(candidatePath: string): string | null {
  return resolveExistingFilePath(candidatePath);
}

function resolveExportTarget(options: {
  extensions: readonly string[];
  packageDirectory: string;
  target: string;
}): string | null {
  if (!options.target.startsWith('./')) return null;
  const targetPath = path.resolve(
    options.packageDirectory,
    options.target.slice(2),
  );
  const resolved = candidatePathsForBasePath(targetPath, options.extensions)
    .map(resolveCandidatePath)
    .find((candidate) => candidate !== null);
  return resolved === undefined ? null : resolved;
}

function getManifestExports(manifest: { exports?: unknown } | null): unknown {
  return manifest === null ? undefined : manifest.exports;
}

function resolveFirstExportTarget(options: {
  extensions: readonly string[];
  packageDirectory: string;
  targets: readonly string[];
}): string | null {
  const resolved = options.targets
    .map((target) => resolveExportTarget({ ...options, target }))
    .find((candidate) => candidate !== null);
  return resolved === undefined ? null : resolved;
}

function resolvePackageDirectoryCandidate(options: {
  extensions: readonly string[];
  packageDirectory: string;
  subpath: string;
}): string | null {
  const manifest = readPackageManifest(options.packageDirectory);
  return resolveFirstExportTarget({
    extensions: options.extensions,
    packageDirectory: options.packageDirectory,
    targets: collectExportTargetsForSubpath(
      getManifestExports(manifest),
      options.subpath,
    ),
  });
}

export function resolvePackageExportModuleCandidate(options: {
  containingFile: string;
  extensions: readonly string[];
  specifier: string;
}): string | null {
  const specifierParts = parsePackageSpecifier(options.specifier);
  if (specifierParts === null) return null;
  const packageDirectory = findPackageDirectoryForImport({
    containingFile: options.containingFile,
    packageName: specifierParts.packageName,
  });
  if (packageDirectory === null) return null;
  return resolvePackageDirectoryCandidate({
    extensions: options.extensions,
    packageDirectory,
    subpath: specifierParts.subpath,
  });
}
