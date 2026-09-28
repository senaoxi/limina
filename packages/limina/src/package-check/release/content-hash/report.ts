import {
  CONTENT_HASH_DIFF_KINDS,
  type ContentHashDiffGroup,
  type ContentHashDiffKind,
  type IgnoredContentHashDiffGroup,
  type WorkspacePackageOutputComparison,
} from '../consistency/types';

function hasContentHashDiffs(group: ContentHashDiffGroup): boolean {
  return CONTENT_HASH_DIFF_KINDS.some((kind) => group[kind].length > 0);
}

function formatDiffKind(options: {
  diffs: ContentHashDiffGroup;
  kind: ContentHashDiffKind;
}): string[] {
  const paths = options.diffs[options.kind].map((diff) => diff.relativePath);
  if (paths.length === 0) return [];
  return [
    `  ${options.kind}:`,
    ...paths.map((relativePath) => `    ${relativePath}`),
  ];
}

export function formatReleaseRelevantContentHashDiffs(
  diffs: ContentHashDiffGroup,
): string[] {
  if (!hasContentHashDiffs(diffs)) return [];
  return [
    '',
    'Release-relevant diffs:',
    ...CONTENT_HASH_DIFF_KINDS.flatMap((kind) =>
      formatDiffKind({ diffs, kind }),
    ),
  ];
}

function formatIgnoredGroup(group: IgnoredContentHashDiffGroup): string[] {
  return [
    `  ${group.label}:`,
    ...CONTENT_HASH_DIFF_KINDS.map(
      (kind) => `    ${kind}: ${group.diffs[kind].length}`,
    ),
  ];
}

export function formatIgnoredContentHashDiffs(
  groups: readonly IgnoredContentHashDiffGroup[],
): string[] {
  if (groups.length === 0) return [];
  return [
    '',
    'Ignored contentHash diffs:',
    ...groups.flatMap(formatIgnoredGroup),
  ];
}

function resolveLocalVersion(options: {
  comparison: WorkspacePackageOutputComparison;
  localVersionFallback: string | undefined;
}): string {
  if (options.comparison.localVersion !== null) {
    return options.comparison.localVersion;
  }
  if (options.localVersionFallback !== undefined) {
    return options.localVersionFallback;
  }
  return '(missing version)';
}

export function formatContentHashComparisonReport(options: {
  baselineTag: string;
  baselineVersion: string;
  comparison: WorkspacePackageOutputComparison;
  dependencyName: string;
  importerName: string;
  localVersionFallback: string | undefined;
}): string {
  const status = options.comparison.matchesBaseline ? 'PASS' : 'FAIL';
  const localVersion = resolveLocalVersion(options);
  return [
    `[release-check] ${status} ${options.importerName} -> ${options.dependencyName}`,
    `Baseline: npm ${options.baselineTag} -> ${options.dependencyName}@${options.baselineVersion}`,
    `Local: ${options.dependencyName}@${localVersion}`,
    ...formatReleaseRelevantContentHashDiffs(
      options.comparison.releaseRelevantDiffs,
    ),
    ...formatIgnoredContentHashDiffs(options.comparison.ignoredDiffGroups),
  ].join('\n');
}
