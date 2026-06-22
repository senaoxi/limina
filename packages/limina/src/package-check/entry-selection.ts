import type {
  PackageCheckTool,
  PackageCheckToolSelection,
  PackageEntry,
  ResolvedLiminaConfig,
} from '#config/runner';
import { existsSync, readFileSync } from 'node:fs';
import path from 'pathe';
import { formatErrorMessage } from '../logger';

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

function findNearestPackageJsonPath(
  cwd: string,
  rootDir: string,
): string | undefined {
  const resolvedRootDir = path.resolve(rootDir);
  let currentDir = path.resolve(cwd);

  while (true) {
    const relativeToRoot = path.relative(resolvedRootDir, currentDir);
    const isWithinRoot =
      relativeToRoot === '' ||
      (relativeToRoot !== '..' &&
        !relativeToRoot.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relativeToRoot));

    if (!isWithinRoot) {
      return undefined;
    }

    const packageJsonPath = path.join(currentDir, 'package.json');

    if (existsSync(packageJsonPath)) {
      return packageJsonPath;
    }

    if (currentDir === resolvedRootDir) {
      return undefined;
    }

    const parentDir = path.dirname(currentDir);

    if (parentDir === currentDir) {
      return undefined;
    }

    currentDir = parentDir;
  }
}

function readCwdPackageName(cwd: string, rootDir: string): string | undefined {
  const packageJsonPath = findNearestPackageJsonPath(cwd, rootDir);

  if (!packageJsonPath) {
    return undefined;
  }

  try {
    const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      name?: unknown;
    };

    return typeof manifest.name === 'string' && manifest.name.trim()
      ? manifest.name.trim()
      : undefined;
  } catch (error) {
    throw new Error(
      `Unable to read package name from ${packageJsonPath}: ${formatErrorMessage(
        error,
      )}`,
    );
  }
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
}): PackageEntrySelectionPlan {
  const entries = getConfiguredPackageEntries(options.config);

  if (entries.length === 0) {
    throw new Error('No package entries are configured.');
  }

  let selectedEntries: PackageEntry[];
  let selectionReason: string;
  const packageNames = normalizePackageNameFilters(options.packageNames);

  if (packageNames.length > 0) {
    selectedEntries = packageNames.map((packageName) => {
      const entry = entries.find((candidate) => candidate.name === packageName);

      if (!entry) {
        throw new Error(
          [
            `No package entry named "${packageName}" is configured.`,
            `Configured package entries: ${formatConfiguredPackageEntryNames(
              entries,
            )}.`,
          ].join(' '),
        );
      }

      return entry;
    });

    selectionReason = `--package matched configured package entry name(s): ${packageNames.join(', ')}.`;
  } else {
    const cwdPackageName = readCwdPackageName(
      options.cwd,
      options.config.rootDir,
    );

    if (cwdPackageName) {
      selectedEntries = entries.filter(
        (entry) => entry.name === cwdPackageName,
      );

      if (selectedEntries.length > 0) {
        selectionReason = `nearest package.json name "${cwdPackageName}" matched configured package entry name.`;
      } else if (options.requireCwdPackageMatch) {
        throw new Error(
          [
            `Nearest package.json name "${cwdPackageName}" does not match a configured package entry.`,
            `Configured package entries: ${formatConfiguredPackageEntryNames(
              entries,
            )}.`,
          ].join(' '),
        );
      } else {
        selectedEntries = entries;
        selectionReason = `nearest package.json name "${cwdPackageName}" did not match configured package entries; running all configured entries.`;
      }
    } else if (options.requireCwdPackageMatch) {
      throw new Error(
        [
          'No package name was found from cwd up to the workspace root.',
          'Run from a configured package directory or pass --package <name>.',
        ].join(' '),
      );
    } else {
      selectedEntries = entries;
      selectionReason =
        'No package name was found from cwd up to the workspace root; running all configured entries.';
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
