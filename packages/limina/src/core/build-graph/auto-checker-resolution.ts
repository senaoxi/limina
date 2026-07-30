import { getCheckerExtensions } from '#checkers';
import {
  type CheckerConfigMode,
  isAutoCheckerConfigMode,
  type ResolvedCheckerConfig,
  type ResolvedLiminaConfig,
} from '#config/runner';
import { toPosixPath, toRelativePath } from '#utils/path';
import { resolveCheckerEntrySelection } from '../checkers/entry-selection';
import type { WorkspaceRegionPathIndex } from '../workspace/validated-context';
import { collectAutoScopeDependencies } from './auto-checker-dependencies';
import { promoteAutoScopes } from './auto-checker-promotion';
import { classifyAutoScope, collectAutoScope } from './auto-checker-scope';
import type {
  AutoCheckerPreset,
  AutoScope,
  PrepareGeneratedTsconfigGraphOptions,
  ResolvedCheckerEntrySelection,
} from './types';

function getConfiguredCheckers(
  config: ResolvedLiminaConfig,
): CheckerConfigMode | undefined {
  return config.config ? config.config.checkers : undefined;
}

function getAutoCheckerExclude(config: ResolvedLiminaConfig): string[] {
  const checkers = getConfiguredCheckers(config);
  if (!isAutoCheckerConfigMode(checkers)) {
    return [];
  }
  return checkers.exclude || [];
}

function createResolvedChecker(options: {
  exclude?: string[];
  include: string[];
  name: string;
  preset: AutoCheckerPreset;
  rootDir: string;
}): ResolvedCheckerConfig {
  return {
    exclude: options.exclude ?? [],
    extensions: getCheckerExtensions(
      { include: options.include, preset: options.preset },
      { projectRootDir: options.rootDir },
    ),
    include: options.include,
    name: options.name,
    preset: options.preset,
  };
}

function appendPresetEntry(options: {
  entriesByPreset: Map<AutoCheckerPreset, string[]>;
  entryConfigPath: string;
  preset: AutoCheckerPreset;
}): void {
  const entries = options.entriesByPreset.get(options.preset) ?? [];
  entries.push(options.entryConfigPath);
  options.entriesByPreset.set(options.preset, entries);
}

function sortPresetEntries(
  entriesByPreset: Map<AutoCheckerPreset, string[]>,
): void {
  for (const entries of entriesByPreset.values()) {
    entries.sort();
  }
}

function groupEntriesByPreset(
  kindsByEntry: ReadonlyMap<string, AutoCheckerPreset>,
): Map<AutoCheckerPreset, string[]> {
  const entriesByPreset = new Map<AutoCheckerPreset, string[]>();
  for (const [entryConfigPath, preset] of kindsByEntry) {
    appendPresetEntry({ entriesByPreset, entryConfigPath, preset });
  }
  sortPresetEntries(entriesByPreset);
  return entriesByPreset;
}

function createAutoSelection(options: {
  config: ResolvedLiminaConfig;
  entries: string[];
  exclude: string[];
  name: string;
  preset: AutoCheckerPreset;
}): ResolvedCheckerEntrySelection | null {
  if (options.entries.length === 0) {
    return null;
  }
  const include = options.entries.map((entryConfigPath) =>
    toPosixPath(toRelativePath(options.config.rootDir, entryConfigPath)),
  );
  return {
    checker: createResolvedChecker({
      exclude: options.exclude,
      include,
      name: options.name,
      preset: options.preset,
      rootDir: options.config.rootDir,
    }),
    selection: {
      effectiveEntryPaths: options.entries,
      includedEntryPaths: options.entries,
    },
  };
}

function createAutoSelections(options: {
  autoExclude: string[];
  config: ResolvedLiminaConfig;
  entriesByPreset: Map<AutoCheckerPreset, string[]>;
}): ResolvedCheckerEntrySelection[] {
  const selections = [
    createAutoSelection({
      config: options.config,
      entries: options.entriesByPreset.get('tsc') ?? [],
      exclude: options.autoExclude,
      name: 'typescript',
      preset: 'tsc',
    }),
    createAutoSelection({
      config: options.config,
      entries: options.entriesByPreset.get('vue-tsc') ?? [],
      exclude: options.autoExclude,
      name: 'vue',
      preset: 'vue-tsc',
    }),
  ];
  return selections.filter(
    (selection): selection is ResolvedCheckerEntrySelection =>
      Boolean(selection),
  );
}

function collectAutoScopes(options: {
  activatedRegions: WorkspaceRegionPathIndex;
  config: ResolvedLiminaConfig;
  entryConfigPaths: readonly string[];
  projectConfigCache?: PrepareGeneratedTsconfigGraphOptions['projectConfigCache'];
}): AutoScope[] {
  return options.entryConfigPaths
    .map((entryConfigPath) => collectAutoScope({ ...options, entryConfigPath }))
    .filter((scope): scope is AutoScope => Boolean(scope));
}

function classifyAutoScopes(options: {
  config: ResolvedLiminaConfig;
  scopes: readonly AutoScope[];
}): Map<string, AutoCheckerPreset> {
  return new Map(
    options.scopes.map((scope) => [
      scope.entryConfigPath,
      classifyAutoScope({ config: options.config, scope }),
    ]),
  );
}

export async function resolveAutoCheckerSelections(options: {
  activatedRegions: WorkspaceRegionPathIndex;
  config: ResolvedLiminaConfig;
  importAnalysisContext?: PrepareGeneratedTsconfigGraphOptions['importAnalysisContext'];
  projectConfigCache?: PrepareGeneratedTsconfigGraphOptions['projectConfigCache'];
  workspaceSourceConfigPaths: readonly string[];
}): Promise<ResolvedCheckerEntrySelection[]> {
  const autoExclude = getAutoCheckerExclude(options.config);
  const selection = await resolveCheckerEntrySelection(
    {
      config: options.config,
      sourceConfigPaths: options.workspaceSourceConfigPaths,
    },
    {
      checkerName: '__auto__',
      exclude: autoExclude,
      include: ['**/tsconfig.json'],
    },
  );
  const scopes = collectAutoScopes({
    activatedRegions: options.activatedRegions,
    config: options.config,
    entryConfigPaths: selection.effectiveEntryPaths,
    projectConfigCache: options.projectConfigCache,
  });
  const kindsByEntry = classifyAutoScopes({ config: options.config, scopes });
  promoteAutoScopes({
    dependenciesByEntry: collectAutoScopeDependencies({
      config: options.config,
      importAnalysisContext: options.importAnalysisContext,
      scopes,
    }),
    kindsByEntry,
  });
  return createAutoSelections({
    autoExclude,
    config: options.config,
    entriesByPreset: groupEntriesByPreset(kindsByEntry),
  });
}
