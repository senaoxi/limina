import type {
  PackageCheckToolSelection,
  PackageEntry,
  ResolvedLiminaConfig,
} from '#config/runner';
import {
  type ValidatedWorkspaceContext,
  WorkspaceRegionPathIndex,
} from '../../core/workspace/validated-context';
import { createEntryPlan, type PlannedPackageEntry } from './selection-tools';

interface SelectedPackageEntries {
  entries: PackageEntry[];
  reason: string;
}

export interface PackageEntrySelectionPlan {
  selectionReason: string;
  entries: PlannedPackageEntry[];
}

function getConfiguredEntryNames(entries: readonly PackageEntry[]): string[] {
  return entries
    .map((entry) => entry.name)
    .filter((name): name is string => Boolean(name));
}

function formatConfiguredPackageEntryNames(entries: PackageEntry[]): string {
  const names = getConfiguredEntryNames(entries);
  return names.length > 0 ? names.join(', ') : '(none)';
}

function getConfiguredPackageEntries(
  config: ResolvedLiminaConfig,
): PackageEntry[] {
  const packageConfig = config.package;
  return packageConfig?.entries ?? [];
}

function appendNormalizedPackageName(
  normalizedNames: string[],
  packageName: string,
): void {
  const normalizedName = packageName.trim();

  if (normalizedName.length === 0) {
    return;
  }

  if (!normalizedNames.includes(normalizedName)) {
    normalizedNames.push(normalizedName);
  }
}

function normalizePackageNameFilters(
  packageNames: readonly string[] | undefined,
): string[] {
  const normalizedNames: string[] = [];
  const names = packageNames === undefined ? [] : packageNames;

  for (const packageName of names) {
    appendNormalizedPackageName(normalizedNames, packageName);
  }

  return normalizedNames;
}

function createMissingEntryError(
  packageName: string,
  entries: PackageEntry[],
): Error {
  return new Error(
    [
      `No package entry named "${packageName}" is configured.`,
      `Configured package entries: ${formatConfiguredPackageEntryNames(entries)}.`,
    ].join(' '),
  );
}

function findEntriesByPackageName(
  entries: PackageEntry[],
  packageName: string,
): PackageEntry[] {
  const matchingEntries = entries.filter(
    (candidate) => candidate.name === packageName,
  );

  if (matchingEntries.length === 0) {
    throw createMissingEntryError(packageName, entries);
  }

  return matchingEntries;
}

function selectByPackageNames(
  entries: PackageEntry[],
  packageNames: readonly string[],
): SelectedPackageEntries {
  return {
    entries: packageNames.flatMap((packageName) =>
      findEntriesByPackageName(entries, packageName),
    ),
    reason: `--package matched configured package entry name(s): ${packageNames.join(', ')}.`,
  };
}

function createCwdMismatchError(
  packageName: string,
  entries: PackageEntry[],
): Error {
  return new Error(
    [
      `Activated workspace package "${packageName}" does not match a configured package entry.`,
      `Configured package entries: ${formatConfiguredPackageEntryNames(entries)}.`,
    ].join(' '),
  );
}

function selectForNamedCwdPackage(options: {
  entries: PackageEntry[];
  packageName: string;
  requireMatch: boolean;
}): SelectedPackageEntries {
  const matchingEntries = options.entries.filter(
    (entry) => entry.name === options.packageName,
  );

  if (matchingEntries.length > 0) {
    return {
      entries: matchingEntries,
      reason: `activated workspace package "${options.packageName}" matched configured package entry name.`,
    };
  }

  if (options.requireMatch) {
    throw createCwdMismatchError(options.packageName, options.entries);
  }

  return {
    entries: options.entries,
    reason: `activated workspace package "${options.packageName}" did not match configured package entries; running all configured entries.`,
  };
}

function selectForUnnamedCwdPackage(
  entries: PackageEntry[],
  requireMatch: boolean,
): SelectedPackageEntries {
  if (requireMatch) {
    throw new Error(
      [
        'The activated workspace package containing cwd has no package name.',
        'Run from a named activated package directory or pass --package <name>.',
      ].join(' '),
    );
  }

  return {
    entries,
    reason:
      'The activated workspace package containing cwd has no package name; running all configured entries.',
  };
}

function selectWithoutCwdPackage(
  entries: PackageEntry[],
  requireMatch: boolean,
): SelectedPackageEntries {
  if (requireMatch) {
    throw new Error(
      [
        'No activated workspace package contains cwd.',
        'Run from an activated package directory or pass --package <name>.',
      ].join(' '),
    );
  }

  return {
    entries,
    reason:
      'No activated workspace package contains cwd; running all configured entries.',
  };
}

function selectByCwd(options: {
  cwd: string;
  entries: PackageEntry[];
  requireMatch: boolean;
  workspaceContext: ValidatedWorkspaceContext;
}): SelectedPackageEntries {
  const cwdPackage = new WorkspaceRegionPathIndex(
    options.workspaceContext,
  ).findPackageForPath(options.cwd);

  if (cwdPackage === null) {
    return selectWithoutCwdPackage(options.entries, options.requireMatch);
  }

  if (cwdPackage.name === undefined) {
    return selectForUnnamedCwdPackage(options.entries, options.requireMatch);
  }

  return selectForNamedCwdPackage({
    entries: options.entries,
    packageName: cwdPackage.name,
    requireMatch: options.requireMatch,
  });
}

function createPlannedEntries(options: {
  config: ResolvedLiminaConfig;
  entries: PackageEntry[];
  selectedEntries: readonly PackageEntry[];
  tool: PackageCheckToolSelection | undefined;
}): PlannedPackageEntry[] {
  return options.selectedEntries.map((entry) =>
    createEntryPlan({
      config: options.config,
      entry,
      entryIndex: options.entries.indexOf(entry),
      requestedTool: options.tool,
    }),
  );
}

function selectEntries(options: {
  cwd: string;
  entries: PackageEntry[];
  packageNames: readonly string[];
  requireCwdPackageMatch: boolean;
  workspaceContext: ValidatedWorkspaceContext;
}): SelectedPackageEntries {
  return options.packageNames.length > 0
    ? selectByPackageNames(options.entries, options.packageNames)
    : selectByCwd({
        cwd: options.cwd,
        entries: options.entries,
        requireMatch: options.requireCwdPackageMatch,
        workspaceContext: options.workspaceContext,
      });
}

export function createPackageEntrySelectionPlan(options: {
  config: ResolvedLiminaConfig;
  cwd: string;
  packageNames?: readonly string[];
  requireCwdPackageMatch: boolean;
  tool?: PackageCheckToolSelection;
  workspaceContext: ValidatedWorkspaceContext;
}): PackageEntrySelectionPlan {
  const entries = getConfiguredPackageEntries(options.config);

  if (entries.length === 0) {
    throw new Error('No package entries are configured.');
  }

  const selection = selectEntries({
    cwd: options.cwd,
    entries,
    packageNames: normalizePackageNameFilters(options.packageNames),
    requireCwdPackageMatch: options.requireCwdPackageMatch,
    workspaceContext: options.workspaceContext,
  });

  return {
    entries: createPlannedEntries({
      config: options.config,
      entries,
      selectedEntries: selection.entries,
      tool: options.tool,
    }),
    selectionReason: selection.reason,
  };
}
