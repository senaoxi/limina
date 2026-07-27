import type { ResolvedCheckerConfig } from '#config/runner';
import { uniqueSortedStrings } from '#utils/collections';
import { toRelativePath } from '#utils/path';
import type { CheckIssueReportOptions } from '../../check-reporting/human';
import type { LiminaFlowReporter } from '../../flow';
import { TypecheckLogger } from '../../logger';
import { shouldLogCheckReport } from '../runner-shared';

export interface BuildCheckerCombinationEntry {
  checker: ResolvedCheckerConfig;
  entryConfigPath: string;
  generatedConfigPath: string;
  sourceConfigPath: string;
}

function isCacheCompatiblePreset(preset: string): boolean {
  return preset === 'tsc' || preset === 'vue-tsc';
}

function shouldWarnForBuildCheckerPresetCombination(
  presets: readonly string[],
): boolean {
  const uniquePresets = uniqueSortedStrings(presets);
  if (uniquePresets.length <= 1) return false;
  return !uniquePresets.every(isCacheCompatiblePreset);
}

function getOrCreateGeneratedGroup(
  groups: Map<string, BuildCheckerCombinationEntry[]>,
  path: string,
): BuildCheckerCombinationEntry[] {
  const existing = groups.get(path);
  if (existing !== undefined) return existing;
  const created: BuildCheckerCombinationEntry[] = [];
  groups.set(path, created);
  return created;
}

function groupEntriesByGeneratedConfig(
  entries: readonly BuildCheckerCombinationEntry[],
): Map<string, BuildCheckerCombinationEntry[]> {
  const groups = new Map<string, BuildCheckerCombinationEntry[]>();
  for (const entry of entries) {
    getOrCreateGeneratedGroup(groups, entry.generatedConfigPath).push(entry);
  }
  return groups;
}

function compareConfigPaths(
  projectRootDir: string,
  left: string,
  right: string,
): number {
  return toRelativePath(projectRootDir, left).localeCompare(
    toRelativePath(projectRootDir, right),
  );
}

function getWarningGroups(options: {
  entries: readonly BuildCheckerCombinationEntry[];
  projectRootDir: string;
}): [string, BuildCheckerCombinationEntry[]][] {
  return [...groupEntriesByGeneratedConfig(options.entries).entries()]
    .filter(([, entries]) =>
      shouldWarnForBuildCheckerPresetCombination(
        entries.map((entry) => entry.checker.preset),
      ),
    )
    .sort(([left], [right]) =>
      compareConfigPaths(options.projectRootDir, left, right),
    );
}

function getCheckerKey(checker: ResolvedCheckerConfig): string {
  return `${checker.name}\0${checker.preset}`;
}

interface CheckerEntryGroup {
  checker: ResolvedCheckerConfig;
  entryConfigPaths: Set<string>;
}

function getOrCreateCheckerEntries(
  groups: Map<string, CheckerEntryGroup>,
  checker: ResolvedCheckerConfig,
): CheckerEntryGroup {
  const key = getCheckerKey(checker);
  const existing = groups.get(key);
  if (existing !== undefined) return existing;
  const created = { checker, entryConfigPaths: new Set<string>() };
  groups.set(key, created);
  return created;
}

function compareCheckerGroups(
  left: CheckerEntryGroup,
  right: CheckerEntryGroup,
): number {
  const nameOrder = left.checker.name.localeCompare(right.checker.name);
  if (nameOrder !== 0) return nameOrder;
  return left.checker.preset.localeCompare(right.checker.preset);
}

function formatEntryConfigPaths(options: {
  entryConfigPaths: ReadonlySet<string>;
  projectRootDir: string;
}): string[] {
  return [...options.entryConfigPaths]
    .sort((left, right) =>
      compareConfigPaths(options.projectRootDir, left, right),
    )
    .map(
      (entryConfigPath) =>
        `        - ${toRelativePath(options.projectRootDir, entryConfigPath)}`,
    );
}

function groupEntriesByChecker(
  entries: readonly BuildCheckerCombinationEntry[],
): CheckerEntryGroup[] {
  const groups = new Map<string, CheckerEntryGroup>();
  for (const entry of entries) {
    getOrCreateCheckerEntries(groups, entry.checker).entryConfigPaths.add(
      entry.entryConfigPath,
    );
  }
  return [...groups.values()].sort(compareCheckerGroups);
}

function formatBuildCheckerCombinationReachability(options: {
  entries: readonly BuildCheckerCombinationEntry[];
  projectRootDir: string;
}): string[] {
  return groupEntriesByChecker(options.entries).flatMap((group) => [
    `    - config.checkers.${group.checker.name} (${group.checker.preset})`,
    '      entry tsconfigs:',
    ...formatEntryConfigPaths({
      entryConfigPaths: group.entryConfigPaths,
      projectRootDir: options.projectRootDir,
    }),
  ]);
}

function formatWarningGroup(options: {
  entries: readonly BuildCheckerCombinationEntry[];
  generatedConfigPath: string;
  projectRootDir: string;
}): string[] {
  const first = options.entries[0];
  if (first === undefined) return [];
  return [
    `  generated config: ${toRelativePath(
      options.projectRootDir,
      options.generatedConfigPath,
    )}`,
    `  source config: ${toRelativePath(
      options.projectRootDir,
      first.sourceConfigPath,
    )}`,
    '  reachable from:',
    ...formatBuildCheckerCombinationReachability(options),
  ];
}

function formatBuildCheckerCombinationWarning(options: {
  entries: readonly BuildCheckerCombinationEntry[];
  projectRootDir: string;
}): string | null {
  const warningGroups = getWarningGroups(options);
  if (warningGroups.length === 0) return null;
  return [
    'Potentially incompatible build checker combination:',
    '  reason: these checker presets can reach the same generated declaration config but do not safely share underlying build cache semantics.',
    '  fix: use a single cache-compatible build checker path for this generated config, or use a file-compatible tsc + vue-tsc combination.',
    ...warningGroups.flatMap(([generatedConfigPath, entries]) =>
      formatWarningGroup({
        entries,
        generatedConfigPath,
        projectRootDir: options.projectRootDir,
      }),
    ),
  ].join('\n');
}

function emitFlowWarning(options: {
  flow: LiminaFlowReporter | undefined;
  flowDepth: number;
  warning: string;
}): void {
  options.flow?.warn(options.warning, {
    depth: options.flowDepth + 1,
    persistInteractive: true,
  });
}

function shouldLogWarning(options: {
  flow?: LiminaFlowReporter;
  report?: CheckIssueReportOptions;
}): boolean {
  if (options.flow?.interactive === true) return false;
  return shouldLogCheckReport(options.report);
}

export function reportBuildCheckerCombinationWarning(options: {
  entries: readonly BuildCheckerCombinationEntry[];
  flow?: LiminaFlowReporter;
  flowDepth: number;
  projectRootDir: string;
  report?: CheckIssueReportOptions;
}): void {
  const warning = formatBuildCheckerCombinationWarning(options);
  if (warning === null) return;
  emitFlowWarning({
    flow: options.flow,
    flowDepth: options.flowDepth,
    warning,
  });
  if (shouldLogWarning(options)) TypecheckLogger.warn(warning);
}

export {
  collectBuildGraphCombinationEntries,
  collectCheckerBuildCombinationRoots,
  type CheckerCombinationRoot,
} from './combination-graph';
