import type { NamedWorkspacePackage } from '#core/workspace/actions';
import { isPlainRecord } from '#utils/values';
import path from 'pathe';
import type {
  CollectedPackageExportEntries,
  PackageExportEntry,
} from './types';
import {
  collectExportTargets,
  expandWildcardExportEntry,
  getSpecifierForSubpath,
  isNullPackageExport,
  isSubpathExportMap,
} from './wildcards';

interface RawExportEntry {
  subpath: string;
  value: unknown;
}

function isExportSubpath(subpath: string): boolean {
  if (subpath === '.') return true;
  return subpath.startsWith('./');
}

function getSubpathEntries(
  exportsField: Record<string, unknown>,
): RawExportEntry[] {
  return Object.entries(exportsField)
    .filter(([subpath]) => isExportSubpath(subpath))
    .map(([subpath, value]) => ({ subpath, value }));
}

function getRawExportEntries(exportsField: unknown): RawExportEntry[] {
  if (isPlainRecord(exportsField) && isSubpathExportMap(exportsField)) {
    return getSubpathEntries(exportsField);
  }
  return [{ subpath: '.', value: exportsField }];
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

function compareEntries(
  left: PackageExportEntry,
  right: PackageExportEntry,
): number {
  return left.specifier.localeCompare(right.specifier);
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
