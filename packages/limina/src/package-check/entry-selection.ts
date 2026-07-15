import type {
  PackageCheckTool,
  PackageCheckToolSelection,
  PackageEntry,
  ResolvedLiminaConfig,
} from '#config/runner';
import path from 'pathe';
import {
  type ValidatedWorkspaceContext,
  WorkspaceRegionPathIndex,
} from '../core/workspace/validated-context';

interface PlannedPackageEntry {
  checks: PackageCheckTool[];
  entryIndex: number;
  label: string;
  outDir: string;
  rawEntry: PackageEntry;
}

export interface PackageEntrySelectionPlan {
  selectionReason: string;
  entries: PlannedPackageEntry[];
}

const DEFAULT_PACKAGE_CHECKS: PackageCheckTool[] = [
  'publint',
  'attw',
  'boundary',
];

const PACKAGE_CHECK_TOOLS: Set<PackageCheckTool> = new Set(
  DEFAULT_PACKAGE_CHECKS,
);

function applyPackageToolToggle(
  checks: PackageCheckTool[],
  tool: PackageCheckTool,
  value: boolean | object | undefined,
): PackageCheckTool[] {
  if (value === undefined) {
    return checks;
  }

  if (value === false) {
    return checks.filter((check) => check !== tool);
  }

  return checks.includes(tool) ? checks : [...checks, tool];
}

function normalizeEntryChecks(entry: PackageEntry): PackageCheckTool[] {
  const checks = entry.checks ?? DEFAULT_PACKAGE_CHECKS;
  const normalizedChecks: PackageCheckTool[] = [];

  for (const check of checks) {
    if (!PACKAGE_CHECK_TOOLS.has(check)) {
      throw new Error(
        `Invalid package check "${check}". Expected one of: publint, attw, boundary.`,
      );
    }

    if (!normalizedChecks.includes(check)) {
      normalizedChecks.push(check);
    }
  }

  return applyPackageToolToggle(
    applyPackageToolToggle(normalizedChecks, 'publint', entry.publint),
    'attw',
    entry.attw,
  );
}

function selectEntryChecks(
  entry: PackageEntry,
  requestedTool: PackageCheckToolSelection | undefined,
): PackageCheckTool[] {
  const configuredChecks = normalizeEntryChecks(entry);

  if (!requestedTool || requestedTool === 'all') {
    return configuredChecks;
  }

  return configuredChecks.includes(requestedTool) ? [requestedTool] : [];
}

function formatConfiguredPackageEntryNames(entries: PackageEntry[]): string {
  const names = entries.map((entry) => entry.name).filter(Boolean);

  return names.length > 0 ? names.join(', ') : '(none)';
}

function getConfiguredPackageEntries(
  config: ResolvedLiminaConfig,
): PackageEntry[] {
  return config.package?.entries ?? [];
}

function normalizePackageNameFilters(
  packageNames: readonly string[] | undefined,
): string[] {
  const normalizedNames: string[] = [];

  for (const packageName of packageNames ?? []) {
    const normalizedName = packageName.trim();

    if (normalizedName && !normalizedNames.includes(normalizedName)) {
      normalizedNames.push(normalizedName);
    }
  }

  return normalizedNames;
}

function resolvePackageEntryOutDir(options: {
  config: ResolvedLiminaConfig;
  entry: PackageEntry;
  entryIndex: number;
}): string {
  const outDir = (options.entry as { outDir?: unknown }).outDir;

  if (typeof outDir !== 'string' || outDir.trim().length === 0) {
    throw new Error(
      `Invalid package entry at package.entries[${options.entryIndex}].outDir. Expected a non-empty string.`,
    );
  }

  return path.resolve(options.config.rootDir, outDir);
}

function getPackageEntryLabel(options: {
  entry: PackageEntry;
  entryIndex: number;
}): string {
  const name = (options.entry as { name?: unknown }).name;

  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new Error(
      `Invalid package entry at package.entries[${options.entryIndex}].name. Expected a non-empty string.`,
    );
  }

  return name.trim();
}

function createEntryPlan(options: {
  config: ResolvedLiminaConfig;
  entry: PackageEntry;
  entryIndex: number;
  requestedTool: PackageCheckToolSelection | undefined;
}): PlannedPackageEntry {
  const outDir = resolvePackageEntryOutDir({
    config: options.config,
    entry: options.entry,
    entryIndex: options.entryIndex,
  });

  return {
    checks: selectEntryChecks(options.entry, options.requestedTool),
    entryIndex: options.entryIndex,
    label: getPackageEntryLabel({
      entry: options.entry,
      entryIndex: options.entryIndex,
    }),
    outDir,
    rawEntry: options.entry,
  };
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

  let selectedEntries: PackageEntry[];
  let selectionReason: string;
  const packageNames = normalizePackageNameFilters(options.packageNames);

  if (packageNames.length > 0) {
    selectedEntries = packageNames.flatMap((packageName) => {
      const matchingEntries = entries.filter(
        (candidate) => candidate.name === packageName,
      );

      if (matchingEntries.length === 0) {
        throw new Error(
          [
            `No package entry named "${packageName}" is configured.`,
            `Configured package entries: ${formatConfiguredPackageEntryNames(
              entries,
            )}.`,
          ].join(' '),
        );
      }

      return matchingEntries;
    });

    selectionReason = `--package matched configured package entry name(s): ${packageNames.join(', ')}.`;
  } else {
    const cwdPackage = new WorkspaceRegionPathIndex(
      options.workspaceContext,
    ).findPackageForPath(options.cwd);
    const cwdPackageName = cwdPackage?.name;

    if (cwdPackageName) {
      selectedEntries = entries.filter(
        (entry) => entry.name === cwdPackageName,
      );

      if (selectedEntries.length > 0) {
        selectionReason = `activated workspace package "${cwdPackageName}" matched configured package entry name.`;
      } else if (options.requireCwdPackageMatch) {
        throw new Error(
          [
            `Activated workspace package "${cwdPackageName}" does not match a configured package entry.`,
            `Configured package entries: ${formatConfiguredPackageEntryNames(
              entries,
            )}.`,
          ].join(' '),
        );
      } else {
        selectedEntries = entries;
        selectionReason = `activated workspace package "${cwdPackageName}" did not match configured package entries; running all configured entries.`;
      }
    } else if (cwdPackage) {
      if (options.requireCwdPackageMatch) {
        throw new Error(
          [
            'The activated workspace package containing cwd has no package name.',
            'Run from a named activated package directory or pass --package <name>.',
          ].join(' '),
        );
      }

      selectedEntries = entries;
      selectionReason =
        'The activated workspace package containing cwd has no package name; running all configured entries.';
    } else if (options.requireCwdPackageMatch) {
      throw new Error(
        [
          'No activated workspace package contains cwd.',
          'Run from an activated package directory or pass --package <name>.',
        ].join(' '),
      );
    } else {
      selectedEntries = entries;
      selectionReason =
        'No activated workspace package contains cwd; running all configured entries.';
    }
  }

  return {
    selectionReason,
    entries: selectedEntries.map((entry) =>
      createEntryPlan({
        config: options.config,
        entry,
        entryIndex: entries.indexOf(entry),
        requestedTool: options.tool,
      }),
    ),
  };
}
