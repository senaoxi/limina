import type { ResolvedLiminaConfig } from '#config/runner';
import { uniqueBy } from '#utils/collections';
import { normalizeAbsolutePath } from '#utils/path';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'pathe';

const pnpmWorkspaceListTimeoutMs = 120_000;

export interface PackageManifest {
  bin?: Record<string, string> | string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  exports?: unknown;
  imports?: Record<string, unknown>;
  name?: string;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  private?: boolean;
  scripts?: Record<string, string>;
  type?: string;
  version?: string;
  workspaces?: string[];
}

export interface WorkspacePackage {
  directory: string;
  manifest: PackageManifest;
  name?: string;
}

export type NamedWorkspacePackage = WorkspacePackage & {
  name: string;
};

export interface PackageOwner {
  directory: string;
  manifest: PackageManifest;
  name?: string;
  packageJsonPath: string;
}

export interface PnpmWorkspaceListEntry {
  name?: string;
  path?: string;
}

export interface ImporterInfo {
  declaredWorkspaceDependencies: Set<string>;
  directory: string;
  name?: string;
}

export type PublishDependencySectionName =
  | 'dependencies'
  | 'peerDependencies'
  | 'optionalDependencies';

export interface DependencySection {
  dependencies: Record<string, string>;
  name: PublishDependencySectionName;
}

export function readJsonFile<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '')) as T;
}

function stripYamlQuotes(value: string): string {
  const trimmed = value.trim();

  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

export function collectPnpmWorkspacePatterns(source: string): string[] {
  const patterns: string[] = [];
  const lines = source.split(/\r?\n/u);
  let isInsidePackagesSection = false;

  for (const rawLine of lines) {
    const line = rawLine.replaceAll('\t', '    ');
    const trimmedLine = line.trim();

    if (!isInsidePackagesSection) {
      if (trimmedLine === 'packages:') {
        isInsidePackagesSection = true;
      }
      continue;
    }

    if (trimmedLine.length === 0 || trimmedLine.startsWith('#')) {
      continue;
    }

    const indent = line.length - line.trimStart().length;

    if (indent === 0) {
      break;
    }

    if (trimmedLine.startsWith('- ')) {
      patterns.push(stripYamlQuotes(trimmedLine.slice(2)));
    }
  }

  return patterns;
}

export function parsePnpmWorkspaceListJson(
  source: string,
): PnpmWorkspaceListEntry[] {
  const trimmedSource = source.trim();

  if (trimmedSource.length === 0) {
    return [];
  }

  const parsed = JSON.parse(trimmedSource) as unknown;

  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return [];
    }

    const record = entry as Record<string, unknown>;

    if (typeof record.path !== 'string') {
      return [];
    }

    return [
      {
        ...(typeof record.name === 'string' ? { name: record.name } : {}),
        path: record.path,
      },
    ];
  });
}

function getManifestPackageName(manifest: PackageManifest): string | null {
  return typeof manifest.name === 'string' && manifest.name.trim().length > 0
    ? manifest.name.trim()
    : null;
}

export function isNamedWorkspacePackage(
  workspacePackage: WorkspacePackage,
): workspacePackage is NamedWorkspacePackage {
  return Boolean(workspacePackage.name);
}

function readWorkspacePackage(options: {
  config: ResolvedLiminaConfig;
  packageJsonPath: string;
}): WorkspacePackage {
  const packageJsonPath = normalizeAbsolutePath(options.packageJsonPath);
  const manifest = readJsonFile<PackageManifest>(packageJsonPath);
  const name = getManifestPackageName(manifest);

  return {
    directory: normalizeAbsolutePath(path.dirname(packageJsonPath)),
    manifest,
    ...(name ? { name } : {}),
  };
}

function runTextCommand(
  command: string,
  args: string[],
  cwd: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
        timeout: pnpmWorkspaceListTimeoutMs,
      },
      (error, stdout, stderr) => {
        if (error) {
          Object.assign(error, {
            stderr,
            stdout,
          });
          reject(error);
          return;
        }

        resolve(stdout);
      },
    );
  });
}

function getPnpmCommandCandidates(): {
  argsPrefix: string[];
  command: string;
}[] {
  const candidates: { argsPrefix: string[]; command: string }[] = [];
  const npmExecPath = process.env.npm_execpath;

  if (npmExecPath?.includes('pnpm')) {
    candidates.push({
      argsPrefix: [npmExecPath],
      command: process.execPath,
    });
  }

  candidates.push(
    {
      argsPrefix: ['pnpm'],
      command: 'corepack',
    },
    {
      argsPrefix: [],
      command: 'pnpm',
    },
  );

  return uniqueBy(
    candidates,
    (candidate) => `${candidate.command}\0${candidate.argsPrefix.join('\0')}`,
  );
}

function formatCommandError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  if (!error || typeof error !== 'object') {
    return message;
  }

  const record = error as Record<string, unknown>;
  const details: string[] = [];

  if (record.code !== undefined) {
    details.push(`exit code: ${String(record.code)}`);
  }

  if (record.signal !== undefined) {
    details.push(`signal: ${String(record.signal)}`);
  }

  for (const streamName of ['stderr', 'stdout'] as const) {
    const stream = record[streamName];

    if (typeof stream !== 'string') {
      continue;
    }

    const output = stream.trim();

    if (output.length > 0) {
      details.push(`${streamName}: ${output}`);
    }
  }

  if (details.length === 0) {
    return message;
  }

  return `${message} (${details.join('; ')})`;
}

async function collectPnpmListedPackages(
  config: ResolvedLiminaConfig,
): Promise<WorkspacePackage[]> {
  const args = ['recursive', 'list', '--depth', '-1', '--json'];
  const failures: string[] = [];
  let hasSuccessfulListCommand = false;

  for (const candidate of getPnpmCommandCandidates()) {
    let entries: PnpmWorkspaceListEntry[];
    const commandLabel = [
      candidate.command,
      ...candidate.argsPrefix,
      ...args,
    ].join(' ');

    try {
      const source = await runTextCommand(
        candidate.command,
        [...candidate.argsPrefix, ...args],
        config.rootDir,
      );
      entries = parsePnpmWorkspaceListJson(source);
      hasSuccessfulListCommand = true;
    } catch (error) {
      failures.push(`${commandLabel}: ${formatCommandError(error)}`);
      continue;
    }

    const packages: WorkspacePackage[] = [];

    for (const entry of entries) {
      if (!entry.path) {
        continue;
      }

      const directory = normalizeAbsolutePath(entry.path);
      const packageJsonPath = path.join(directory, 'package.json');

      if (!existsSync(packageJsonPath)) {
        continue;
      }

      packages.push(
        readWorkspacePackage({
          config,
          packageJsonPath,
        }),
      );
    }

    if (packages.length > 0) {
      return packages;
    }
  }

  if (hasSuccessfulListCommand) {
    return [];
  }

  if (failures.length > 0) {
    throw new Error(
      [
        'Failed to collect workspace packages via pnpm recursive list.',
        ...failures.map((failure) => `  - ${failure}`),
      ].join('\n'),
    );
  }

  return [];
}

function mergeWorkspacePackages(
  packages: WorkspacePackage[],
): WorkspacePackage[] {
  const byDirectory = new Map<string, WorkspacePackage>();

  for (const workspacePackage of packages) {
    byDirectory.set(workspacePackage.directory, workspacePackage);
  }

  return [...byDirectory.values()].sort((left, right) => {
    const leftHasName = isNamedWorkspacePackage(left);
    const rightHasName = isNamedWorkspacePackage(right);

    if (leftHasName !== rightHasName) {
      return leftHasName ? -1 : 1;
    }

    const leftKey = left.name ?? left.directory;
    const rightKey = right.name ?? right.directory;
    const keyOrder = leftKey.localeCompare(rightKey);

    return keyOrder === 0
      ? left.directory.localeCompare(right.directory)
      : keyOrder;
  });
}

export async function collectWorkspacePackages(
  config: ResolvedLiminaConfig,
): Promise<WorkspacePackage[]> {
  return mergeWorkspacePackages(await collectPnpmListedPackages(config));
}

export async function collectPackageOwners(
  config: ResolvedLiminaConfig,
): Promise<PackageOwner[]> {
  return (await collectWorkspacePackages(config))
    .map((workspacePackage) => ({
      directory: workspacePackage.directory,
      manifest: workspacePackage.manifest,
      ...(workspacePackage.name ? { name: workspacePackage.name } : {}),
      packageJsonPath: normalizeAbsolutePath(
        path.join(workspacePackage.directory, 'package.json'),
      ),
    }))
    .sort((left, right) => right.directory.length - left.directory.length);
}

function getDependencySections(
  importer: PackageManifest,
): Record<string, string>[] {
  return [
    importer.dependencies,
    importer.devDependencies,
    importer.optionalDependencies,
    importer.peerDependencies,
  ].filter((section): section is Record<string, string> => Boolean(section));
}

export function getPublishDependencySections(
  importer: PackageManifest,
): DependencySection[] {
  return [
    {
      dependencies: importer.dependencies,
      name: 'dependencies',
    },
    {
      dependencies: importer.peerDependencies,
      name: 'peerDependencies',
    },
    {
      dependencies: importer.optionalDependencies,
      name: 'optionalDependencies',
    },
  ].filter((section): section is DependencySection =>
    Boolean(section.dependencies),
  );
}

export function isWorkspaceDependencySpecifier(specifier: string): boolean {
  return specifier.startsWith('workspace:');
}

export function isLocalPackageDependencySpecifier(specifier: string): boolean {
  return (
    specifier.startsWith('workspace:') ||
    specifier.startsWith('link:') ||
    specifier.startsWith('file:') ||
    specifier.startsWith('catalog:')
  );
}

export function getPackageRootSpecifier(specifier: string): string {
  if (specifier.startsWith('@')) {
    const [scope, name] = specifier.split('/');

    return scope && name ? `${scope}/${name}` : specifier;
  }

  return specifier.split('/')[0] ?? specifier;
}

export function findPackageForSpecifier(
  specifier: string,
  packages: WorkspacePackage[],
): NamedWorkspacePackage | null {
  const packageName = getPackageRootSpecifier(specifier);

  return (
    packages
      .filter(isNamedWorkspacePackage)
      .find((workspacePackage) => workspacePackage.name === packageName) ?? null
  );
}

export function collectImporters(
  config: ResolvedLiminaConfig,
  packages: WorkspacePackage[],
): ImporterInfo[] {
  const workspacePackageNames = new Set(
    packages
      .filter(isNamedWorkspacePackage)
      .map((workspacePackage) => workspacePackage.name),
  );
  const importerDirectories = new Set<string>([
    config.rootDir,
    ...packages.map((workspacePackage) => workspacePackage.directory),
  ]);
  const importers: ImporterInfo[] = [];

  for (const importerDirectory of importerDirectories) {
    const packageJsonPath = path.join(importerDirectory, 'package.json');

    if (!existsSync(packageJsonPath)) {
      continue;
    }

    const manifest = readJsonFile<PackageManifest>(packageJsonPath);
    const declaredWorkspaceDependencies = new Set<string>();

    for (const dependencies of getDependencySections(manifest)) {
      for (const dependencyName of Object.keys(dependencies)) {
        if (!workspacePackageNames.has(dependencyName)) {
          continue;
        }

        declaredWorkspaceDependencies.add(dependencyName);
      }
    }

    importers.push({
      declaredWorkspaceDependencies,
      directory: importerDirectory,
      name: manifest.name,
    });
  }

  return importers.sort(
    (left, right) => right.directory.length - left.directory.length,
  );
}
