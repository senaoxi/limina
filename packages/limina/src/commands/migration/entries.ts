import {
  getActiveCheckers,
  isAutoCheckerConfigMode,
  type ResolvedLiminaConfig,
} from '#config/runner';
import {
  createCheckerEntrySelectionOptions,
  resolveCheckerEntrySelection,
} from '../../core/checkers/entry-selection';
import type { MigrationEntry, MigrationEntryCollection } from './types';

function isAutoCheckerMode(config: ResolvedLiminaConfig): boolean {
  return (
    config.config?.checkers === undefined ||
    isAutoCheckerConfigMode(config.config.checkers)
  );
}

function getConfiguredCheckers(
  config: ResolvedLiminaConfig,
): NonNullable<ResolvedLiminaConfig['config']>['checkers'] | undefined {
  const rootConfig = config.config;
  return rootConfig === undefined ? undefined : rootConfig.checkers;
}

function getExcludePatterns(checkers: { exclude?: string[] }): string[] {
  const exclude = checkers.exclude;
  return exclude === undefined ? [] : exclude;
}

function getAutoExcludePatterns(config: ResolvedLiminaConfig): string[] {
  const checkers = getConfiguredCheckers(config);
  return isAutoCheckerConfigMode(checkers) ? getExcludePatterns(checkers) : [];
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
  candidateCount: number;
  entries: MigrationEntry[];
}> {
  const selection = await resolveCheckerEntrySelection(
    { config: options.config, sourceConfigPaths: options.sourceConfigPaths },
    createCheckerEntrySelectionOptions(options.checker),
  );
  return {
    candidateCount: selection.includedEntryPaths.length,
    entries: selection.effectiveEntryPaths.map((configPath) => ({
      configPath,
    })),
  };
}

async function collectExplicitMigrationEntries(
  config: ResolvedLiminaConfig,
  sourceConfigPaths: readonly string[],
): Promise<MigrationEntryCollection> {
  const checkers = getActiveCheckers(config);
  const includePatterns = new Set<string>();
  const excludePatterns = new Set<string>();
  const entries: MigrationEntry[] = [];
  let candidateEntryCount = 0;

  for (const checker of checkers) {
    addPatterns(includePatterns, checker.include);
    addPatterns(excludePatterns, checker.exclude);
    const collected = await collectCheckerEntries({
      checker,
      config,
      sourceConfigPaths,
    });
    candidateEntryCount += collected.candidateCount;
    entries.push(...collected.entries);
  }

  return {
    activeCheckerCount: checkers.length,
    candidateEntryCount,
    entries,
    excludePatterns: [...excludePatterns].sort(),
    includePatterns: [...includePatterns].sort(),
    mode: 'explicit',
  };
}

export async function collectMigrationEntries(
  config: ResolvedLiminaConfig,
  sourceConfigPaths: readonly string[],
): Promise<MigrationEntryCollection> {
  return isAutoCheckerMode(config)
    ? collectAutoMigrationEntries(config, sourceConfigPaths)
    : collectExplicitMigrationEntries(config, sourceConfigPaths);
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
      : 'explicit checker mode expands config.checkers.<name>.include inside activated regions, then applies each checker exclude.';
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
      '  fix: check Limina config.checkers include/exclude, or switch from auto mode to explicit checker includes for the tsconfig.json entries Limina should govern.',
    ].join('\n'),
  );
}
