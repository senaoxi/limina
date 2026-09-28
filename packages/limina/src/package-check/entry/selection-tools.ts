import type {
  PackageCheckTool,
  PackageCheckToolSelection,
  PackageEntry,
  ResolvedLiminaConfig,
} from '#config/runner';
import path from 'pathe';

export interface PlannedPackageEntry {
  checks: PackageCheckTool[];
  entryIndex: number;
  label: string;
  outDir: string;
  rawEntry: PackageEntry;
}

const DEFAULT_PACKAGE_CHECKS: PackageCheckTool[] = [
  'publint',
  'attw',
  'boundary',
];

const PACKAGE_CHECK_TOOLS: Set<PackageCheckTool> = new Set(
  DEFAULT_PACKAGE_CHECKS,
);

function appendTool(
  checks: PackageCheckTool[],
  tool: PackageCheckTool,
): PackageCheckTool[] {
  return checks.includes(tool) ? checks : [...checks, tool];
}

function applyPackageToolToggle(
  checks: PackageCheckTool[],
  tool: PackageCheckTool,
  value: boolean | object | undefined,
): PackageCheckTool[] {
  if (value === undefined) {
    return checks;
  }

  return value === false
    ? checks.filter((check) => check !== tool)
    : appendTool(checks, tool);
}

function getConfiguredChecks(entry: PackageEntry): readonly PackageCheckTool[] {
  return entry.checks === undefined ? DEFAULT_PACKAGE_CHECKS : entry.checks;
}

function assertSupportedPackageCheck(check: PackageCheckTool): void {
  if (!PACKAGE_CHECK_TOOLS.has(check)) {
    throw new Error(
      `Invalid package check "${check}". Expected one of: publint, attw, boundary.`,
    );
  }
}

function appendUniqueCheck(
  checks: PackageCheckTool[],
  check: PackageCheckTool,
): void {
  if (!checks.includes(check)) {
    checks.push(check);
  }
}

function normalizeConfiguredChecks(entry: PackageEntry): PackageCheckTool[] {
  const normalizedChecks: PackageCheckTool[] = [];

  for (const check of getConfiguredChecks(entry)) {
    assertSupportedPackageCheck(check);
    appendUniqueCheck(normalizedChecks, check);
  }

  return normalizedChecks;
}

function normalizeEntryChecks(entry: PackageEntry): PackageCheckTool[] {
  const checks = normalizeConfiguredChecks(entry);
  const withPublint = applyPackageToolToggle(checks, 'publint', entry.publint);
  return applyPackageToolToggle(withPublint, 'attw', entry.attw);
}

function isSpecificTool(
  requestedTool: PackageCheckToolSelection | undefined,
): requestedTool is PackageCheckTool {
  return requestedTool !== undefined && requestedTool !== 'all';
}

function selectRequestedTool(
  checks: readonly PackageCheckTool[],
  requestedTool: PackageCheckTool,
): PackageCheckTool[] {
  return checks.includes(requestedTool) ? [requestedTool] : [];
}

function selectEntryChecks(
  entry: PackageEntry,
  requestedTool: PackageCheckToolSelection | undefined,
): PackageCheckTool[] {
  const configuredChecks = normalizeEntryChecks(entry);

  if (isSpecificTool(requestedTool)) {
    return selectRequestedTool(configuredChecks, requestedTool);
  }

  return configuredChecks;
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

export function createEntryPlan(options: {
  config: ResolvedLiminaConfig;
  entry: PackageEntry;
  entryIndex: number;
  requestedTool: PackageCheckToolSelection | undefined;
}): PlannedPackageEntry {
  return {
    checks: selectEntryChecks(options.entry, options.requestedTool),
    entryIndex: options.entryIndex,
    label: getPackageEntryLabel(options),
    outDir: resolvePackageEntryOutDir(options),
    rawEntry: options.entry,
  };
}
