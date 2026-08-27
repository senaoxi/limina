import {
  getActiveCheckers,
  getAutoCheckerConfig,
  type ResolvedLiminaConfig,
} from '#config/runner';
import {
  createCheckerEntrySelectionOptions,
  resolveCheckerEntrySelection,
} from '../../core/checkers/entry-selection';
import type { MigrationEntry, MigrationEntryCollection } from './types';

function getConfiguredCheckers(
  config: ResolvedLiminaConfig,
): NonNullable<ResolvedLiminaConfig['config']>['checkers'] | undefined {
  const rootConfig = config.config;
  return rootConfig === undefined ? undefined : rootConfig.checkers;
}

function getAutoExcludePatterns(config: ResolvedLiminaConfig): string[] {
  const checkers = getConfiguredCheckers(config);
  return getAutoCheckerConfig(checkers).exclude ?? [];
}

async function collectAutoMigrationEntries(
  config: ResolvedLiminaConfig,
  sourceConfigPaths: readonly string[],
): Promise<MigrationEntryCollection> {
  const excludePatterns = getAutoExcludePatterns(config);
  const selection = await resolveCheckerEntrySelection(
    { config, sourceConfigPaths },
    {
      checkerName: '__auto__',
      exclude: excludePatterns,
      include: ['**/tsconfig.json'],
    },
  );
  const entries = selection.effectiveEntryPaths.map((configPath) => ({
    configPath,
  }));
  return {
    activeCheckerCount: entries.length > 0 ? 1 : 0,
    candidateEntryCount: selection.includedEntryPaths.length,
    entries,
    excludePatterns,
    includePatterns: ['**/tsconfig.json'],
    mode: 'auto',
  };
}

function addPatterns(target: Set<string>, patterns: readonly string[]): void {
  for (const pattern of patterns) {
    target.add(pattern);
  }
}

async function collectCheckerEntries(options: {
  checker: ReturnType<typeof getActiveCheckers>[number];
  config: ResolvedLiminaConfig;
  sourceConfigPaths: readonly string[];
}): Promise<{
  entries: MigrationEntry[];
}> {
  const selection = await resolveCheckerEntrySelection(
    { config: options.config, sourceConfigPaths: options.sourceConfigPaths },
    createCheckerEntrySelectionOptions(options.checker),
  );
  return {
    entries: selection.effectiveEntryPaths.map((configPath) => ({
      configPath,
    })),
  };
}

async function collectUnifiedMigrationEntries(
  config: ResolvedLiminaConfig,
  sourceConfigPaths: readonly string[],
): Promise<MigrationEntryCollection> {
  const checkers = getActiveCheckers(config);
  const includePatterns = new Set<string>();
  const excludePatterns = new Set<string>();
  const entries: MigrationEntry[] = [];

  for (const checker of checkers) {
    addPatterns(includePatterns, checker.include);
    addPatterns(excludePatterns, checker.exclude);
    const collected = await collectCheckerEntries({
      checker,
      config,
      sourceConfigPaths,
    });
    entries.push(...collected.entries);
  }

  const auto = await collectAutoMigrationEntries(config, sourceConfigPaths);
  const entriesByPath = new Map(
    [...auto.entries, ...entries].map((entry) => [entry.configPath, entry]),
  );
  return {
    activeCheckerCount: checkers.length + 1,
    candidateEntryCount: new Set([
      ...auto.entries.map((entry) => entry.configPath),
      ...entries.map((entry) => entry.configPath),
    ]).size,
    entries: [...entriesByPath.values()].sort((left, right) =>
      left.configPath.localeCompare(right.configPath),
    ),
    excludePatterns: [
      ...new Set([...auto.excludePatterns, ...excludePatterns]),
    ].sort(),
    includePatterns: [
      ...new Set([...auto.includePatterns, ...includePatterns]),
    ].sort(),
    mode: 'unified',
  };
}

export async function collectMigrationEntries(
  config: ResolvedLiminaConfig,
  sourceConfigPaths: readonly string[],
): Promise<MigrationEntryCollection> {
  return getActiveCheckers(config).length === 0
    ? collectAutoMigrationEntries(config, sourceConfigPaths)
    : collectUnifiedMigrationEntries(config, sourceConfigPaths);
}

function formatPatternList(patterns: readonly string[]): string {
  return patterns.length > 0 ? patterns.join(', ') : '(none)';
}

export function createNoMigrationEntryError(
  config: ResolvedLiminaConfig,
  collection: MigrationEntryCollection,
): Error {
  const modeReason =
    collection.mode === 'auto'
      ? 'auto mode scans user-side **/tsconfig.json entries inside activated regions, then applies config.checkers.exclude.'
      : 'unified checker discovery merges automatic tsconfig.json roots with named checker entries; named entries remain active even when auto.exclude filters them.';
  return new Error(
    [
      'Limina migration found no tsconfig.json entries to migrate.',
      `  root: ${config.rootDir}`,
      `  mode: ${collection.mode}`,
      `  active checkers: ${collection.activeCheckerCount}`,
      `  include: ${formatPatternList(collection.includePatterns)}`,
      `  exclude: ${formatPatternList(collection.excludePatterns)}`,
      `  candidate entries before exclude: ${collection.candidateEntryCount}`,
      '  active entries after exclude: 0',
      `  reason: ${modeReason}`,
      '  fix: check config.checkers.auto.exclude and named checker include/exclude scopes for the tsconfig.json entries Limina should govern.',
    ].join('\n'),
  );
}
