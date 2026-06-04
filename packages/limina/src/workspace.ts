import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'pathe';
import { glob } from 'tinyglobby';
import type { ResolvedLiminaConfig } from './config';
import { normalizeAbsolutePath, toRelativePath } from './utils/path';

const pnpmWorkspaceFileName = 'pnpm-workspace.yaml';
const pnpmWorkspaceListTimeoutMs = 3000;

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
  name: string;
}

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
  directory: string;
  name?: string;
  workspaceDependencies: Set<string>;
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
  return JSON.parse(readFileSync(filePath, 'utf8')) as T;
}

export function stripYamlQuotes(value: string): string {
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
  const parsed = JSON.parse(source) as unknown;

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

function readWorkspacePackage(options: {
  config: ResolvedLiminaConfig;
  packageJsonPath: string;
}): WorkspacePackage {
  const packageJsonPath = normalizeAbsolutePath(options.packageJsonPath);
  const manifest = readJsonFile<PackageManifest>(packageJsonPath);
  const name = getManifestPackageName(manifest);

  if (!name) {
    throw new Error(
      [
        'Workspace package package.json must declare a non-empty name:',
        `  package.json: ${toRelativePath(options.config.rootDir, packageJsonPath)}`,
        '  field: name',
        '  reason: Limina requires every workspace package to have a package.json name so package ownership, dependency edges, and workspace filters are unambiguous.',
      ].join('\n'),
    );
  }

  return {
    directory: normalizeAbsolutePath(path.dirname(packageJsonPath)),
    manifest,
    name,
  };
}

export function collectWorkspacePatterns(
  config: ResolvedLiminaConfig,
): string[] {
  const rootPackageJsonPath = path.join(config.rootDir, 'package.json');
  const patterns = new Set<string>();

  if (existsSync(rootPackageJsonPath)) {
    const rootPackageJson = readJsonFile<PackageManifest>(rootPackageJsonPath);

    if (Array.isArray(rootPackageJson.workspaces)) {
      for (const pattern of rootPackageJson.workspaces) {
        patterns.add(pattern);
      }
    }
  }

  const workspacePath = path.join(config.rootDir, pnpmWorkspaceFileName);

  if (existsSync(workspacePath)) {
    for (const pattern of collectPnpmWorkspacePatterns(
      readFileSync(workspacePath, 'utf8'),
    )) {
      patterns.add(pattern);
    }
  }

  return [...patterns].sort();
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
      (error, stdout) => {
        if (error) {
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

  const seen = new Set<string>();

  return candidates.filter((candidate) => {
    const key = `${candidate.command}\0${candidate.argsPrefix.join('\0')}`;

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

async function collectPnpmListedPackages(
  config: ResolvedLiminaConfig,
): Promise<WorkspacePackage[]> {
  const args = ['recursive', 'list', '--depth', '-1', '--json'];

  for (const candidate of getPnpmCommandCandidates()) {
    let entries: PnpmWorkspaceListEntry[];

    try {
      const source = await runTextCommand(
        candidate.command,
        [...candidate.argsPrefix, ...args],
        config.rootDir,
      );
      entries = parsePnpmWorkspaceListJson(source);
    } catch {
      // Fall through to the next pnpm launcher, then to glob-based discovery.
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

  return [];
}

async function collectWorkspacePackagesFromPatterns(
  config: ResolvedLiminaConfig,
): Promise<WorkspacePackage[]> {
  const workspacePatterns = collectWorkspacePatterns(config);
  const includePatterns = workspacePatterns
    .filter((pattern) => !pattern.startsWith('!'))
    .map((pattern) => `${pattern.replace(/\/$/u, '')}/package.json`);
  const ignorePatterns = workspacePatterns
    .filter((pattern) => pattern.startsWith('!'))
    .map((pattern) => `${pattern.slice(1).replace(/\/$/u, '')}/**`);
  const packageJsonPaths = new Set<string>(
    await glob(includePatterns, {
      cwd: config.rootDir,
      absolute: false,
      ignore: ['**/node_modules/**', '**/dist/**', ...ignorePatterns],
    }),
  );

  if (existsSync(path.join(config.rootDir, 'package.json'))) {
    packageJsonPaths.add('package.json');
  }

  const packages: WorkspacePackage[] = [];

  for (const packageJsonPath of [...new Set(packageJsonPaths)].sort()) {
    packages.push(
      readWorkspacePackage({
        config,
        packageJsonPath: path.join(config.rootDir, packageJsonPath),
      }),
    );
  }
  return packages;
}

function mergeWorkspacePackages(
  packages: WorkspacePackage[],
): WorkspacePackage[] {
  const byDirectory = new Map<string, WorkspacePackage>();

  for (const workspacePackage of packages) {
    byDirectory.set(workspacePackage.directory, workspacePackage);
  }

  return [...byDirectory.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

export async function collectWorkspacePackages(
  config: ResolvedLiminaConfig,
): Promise<WorkspacePackage[]> {
  const [pnpmPackages, patternPackages] = await Promise.all([
    collectPnpmListedPackages(config),
    collectWorkspacePackagesFromPatterns(config),
  ]);

  return mergeWorkspacePackages([...pnpmPackages, ...patternPackages]);
}

export async function collectPackageOwners(
  config: ResolvedLiminaConfig,
): Promise<PackageOwner[]> {
  const packageJsonPaths = await glob(['package.json', '**/package.json'], {
    cwd: config.rootDir,
    absolute: false,
    ignore: [
      '**/.git/**',
      '**/.pnpm-store/**',
      '**/.tsbuild/**',
      '**/coverage/**',
      '**/dist/**',
      '**/node_modules/**',
    ],
  });

  return [...new Set(packageJsonPaths)]
    .sort()
    .map((packageJsonPath) => {
      const absolutePackageJsonPath = normalizeAbsolutePath(
        path.join(config.rootDir, packageJsonPath),
      );
      const manifest = readJsonFile<PackageManifest>(absolutePackageJsonPath);

      return {
        directory: normalizeAbsolutePath(path.dirname(absolutePackageJsonPath)),
        manifest,
        name: manifest.name,
        packageJsonPath: absolutePackageJsonPath,
      };
    })
    .sort((left, right) => right.directory.length - left.directory.length);
}

export function getDependencySections(
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
): WorkspacePackage | null {
  const packageName = getPackageRootSpecifier(specifier);

  return (
    packages.find(
      (workspacePackage) => workspacePackage.name === packageName,
    ) ?? null
  );
}

export function readPackageName(directoryPath: string): string | undefined {
  const packageJsonPath = path.join(directoryPath, 'package.json');

  if (!existsSync(packageJsonPath)) {
    return undefined;
  }

  return readJsonFile<{ name?: string }>(packageJsonPath).name;
}

export function collectImporters(
  config: ResolvedLiminaConfig,
  packages: WorkspacePackage[],
): ImporterInfo[] {
  const workspacePackageNames = new Set(
    packages.map((workspacePackage) => workspacePackage.name),
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
    const workspaceDependencies = new Set<string>();

    for (const dependencies of getDependencySections(manifest)) {
      for (const [dependencyName, specifier] of Object.entries(dependencies)) {
        if (
          !workspacePackageNames.has(dependencyName) ||
          !isWorkspaceDependencySpecifier(specifier)
        ) {
          continue;
        }

        workspaceDependencies.add(dependencyName);
      }
    }

    importers.push({
      directory: importerDirectory,
      name: manifest.name,
      workspaceDependencies,
    });
  }

  return importers.sort(
    (left, right) => right.directory.length - left.directory.length,
  );
}
