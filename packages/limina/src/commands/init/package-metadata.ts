import { type PackageManifest, readJsonFile } from '#core/workspace/actions';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'pathe';
import { parse as parseYaml } from 'yaml';
import { pnpmWorkspaceFileName } from './shared';
import type { LiminaPackageMetadata } from './types';
import { findPnpmWorkspaceRoot } from './workspace';

interface WorkspaceCatalogManifest {
  catalog?: Record<string, string>;
  catalogs?: Record<string, Record<string, string>>;
}

function findPnpmWorkspacePath(startDir: string): string | null {
  const rootDir = findPnpmWorkspaceRoot(startDir);
  if (rootDir === null) {
    return null;
  }

  return path.join(rootDir, pnpmWorkspaceFileName);
}

function readWorkspaceCatalog(
  workspacePath: string,
): WorkspaceCatalogManifest | null {
  return parseYaml(
    readFileSync(workspacePath, 'utf8'),
  ) as WorkspaceCatalogManifest | null;
}

function readRecordValue(
  record: Record<string, string> | undefined,
  key: string,
): string | null {
  if (record === undefined) {
    return null;
  }

  const value = record[key];
  return value === undefined ? null : value;
}

function resolveNamedCatalogEntry(options: {
  catalogName: string;
  packageName: string;
  parsed: WorkspaceCatalogManifest;
}): string | null {
  const catalogs = options.parsed.catalogs;
  if (catalogs === undefined) {
    return null;
  }

  return readRecordValue(catalogs[options.catalogName], options.packageName);
}

function isDefaultCatalogName(catalogName: string): boolean {
  return catalogName.length === 0 || catalogName === 'default';
}

function resolveCatalogEntry(options: {
  catalogName: string;
  packageName: string;
  parsed: WorkspaceCatalogManifest | null;
}): string | null {
  if (options.parsed === null) {
    return null;
  }

  if (isDefaultCatalogName(options.catalogName)) {
    return readRecordValue(options.parsed.catalog, options.packageName);
  }

  return resolveNamedCatalogEntry({ ...options, parsed: options.parsed });
}

function resolveCatalogSpecifier(options: {
  packageManifestPath: string;
  packageName: string;
  range: string;
}): string | null {
  const workspacePath = findPnpmWorkspacePath(
    path.dirname(options.packageManifestPath),
  );
  if (workspacePath === null) {
    return null;
  }

  if (!existsSync(workspacePath)) {
    return null;
  }

  return resolveCatalogEntry({
    catalogName: options.range.slice('catalog:'.length),
    packageName: options.packageName,
    parsed: readWorkspaceCatalog(workspacePath),
  });
}

function resolveCatalogRange(options: {
  packageManifestPath: string;
  packageName: string;
  range: string | undefined;
}): string | null {
  if (options.range === undefined) {
    return null;
  }

  if (!options.range.startsWith('catalog:')) {
    return options.range;
  }

  return resolveCatalogSpecifier({ ...options, range: options.range });
}

function getLiminaVersionRange(manifest: PackageManifest): string {
  return manifest.version === undefined ? '^0.0.1' : `^${manifest.version}`;
}

function isString(value: string | null): value is string {
  return value !== null;
}

function getRawTypeScriptRange(manifest: PackageManifest): string | undefined {
  const ranges = [
    readRecordValue(manifest.peerDependencies, 'typescript'),
    readRecordValue(manifest.devDependencies, 'typescript'),
    readRecordValue(manifest.dependencies, 'typescript'),
  ];
  return ranges.find(isString);
}

function getTypeScriptRange(options: {
  manifest: PackageManifest;
  manifestPath: string;
}): string {
  const rawRange = getRawTypeScriptRange(options.manifest);
  const catalogRange = resolveCatalogRange({
    packageManifestPath: options.manifestPath,
    packageName: 'typescript',
    range: rawRange,
  });
  if (catalogRange !== null) {
    return catalogRange;
  }

  return rawRange === undefined ? '^5.9.0' : rawRange;
}

export function readLiminaPackageMetadata(): LiminaPackageMetadata {
  const require = createRequire(import.meta.url);
  const manifestPath = require.resolve('limina/package.json');
  const manifest = readJsonFile<PackageManifest>(manifestPath);
  return {
    typescriptRange: getTypeScriptRange({ manifest, manifestPath }),
    versionRange: getLiminaVersionRange(manifest),
  };
}
