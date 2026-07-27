import type { ResolvedLiminaConfig } from '#config/runner';
import type { NamedWorkspacePackage } from '#core/workspace/actions';
import path from 'pathe';
import { ReleaseLogger } from '../../../logger';
import {
  addContentHashFinding,
  addRegistryFinding,
  formatDependencyLocation,
} from '../consistency/findings';
import type {
  ContentHashIgnoreRule,
  ReleaseConsistencyState,
  WorkspacePackageOutputComparison,
} from '../consistency/types';
import { CONTENT_HASH_DIFF_KINDS } from '../consistency/types';
import {
  compareLocalWorkspacePackageOutputToBaseline,
  createRegistryComparisonFailure,
} from '../content-hash/compare';
import { formatContentHashComparisonReport } from '../content-hash/report';
import type { ReleaseIgnoredContentHashDiffGroup } from '../findings/facts';
import type { WorkspaceRegistryBaseline } from './registry-baseline';

export interface WorkspaceComparisonContext {
  baseline: WorkspaceRegistryBaseline;
  config: ResolvedLiminaConfig;
  dependencyName: string;
  ignoreRules: readonly ContentHashIgnoreRule[];
  importerName: string;
  sourceManifestPath: string;
  state: ReleaseConsistencyState;
  workspacePackage: NamedWorkspacePackage;
}

async function compareWorkspaceOutput(
  context: WorkspaceComparisonContext,
): Promise<WorkspacePackageOutputComparison | null> {
  try {
    return await compareLocalWorkspacePackageOutputToBaseline({
      baselineVersion: context.baseline.baselineVersion,
      config: context.config,
      dependencyName: context.dependencyName,
      expectedShasum: context.baseline.integrityResult.expectedShasum,
      ignoreRules: context.ignoreRules,
      integrity: context.baseline.integrityResult.integrity,
      tarballUrl: context.baseline.tarballUrl,
      workspacePackage: context.workspacePackage,
    });
  } catch (error) {
    const failure = createRegistryComparisonFailure({
      baselineTag: context.baseline.baselineTag,
      baselineVersion: context.baseline.baselineVersion,
      dependencyName: context.dependencyName,
      error,
      importerName: context.importerName,
      integrityResult: context.baseline.integrityResult,
      registryUrl: context.baseline.registryUrl,
      tarballUrl: context.baseline.tarballUrl,
    });
    addRegistryFinding(context.state, {
      facts: failure.facts,
      filePath: context.sourceManifestPath,
      message: `${formatDependencyLocation(context)}: ${[
        `unable to compare local package output for ${context.dependencyName}`,
        `against npm ${context.baseline.baselineTag} ${context.dependencyName}@${context.baseline.baselineVersion}:`,
        failure.errorMessage,
      ].join(' ')}`,
      packageManifestPath: context.sourceManifestPath,
      packageName: context.dependencyName,
    });
    return null;
  }
}

function flattenReleaseRelevantDiffs(
  comparison: WorkspacePackageOutputComparison,
) {
  return CONTENT_HASH_DIFF_KINDS.flatMap(
    (kind) => comparison.releaseRelevantDiffs[kind],
  );
}

function flattenIgnoredDiffs(
  comparison: WorkspacePackageOutputComparison,
): ReleaseIgnoredContentHashDiffGroup[] {
  return comparison.ignoredDiffGroups.map((group) => ({
    diffs: CONTENT_HASH_DIFF_KINDS.flatMap((kind) => group.diffs[kind]),
    ruleIdentity: group.label,
  }));
}

function getContentDiffFilePath(options: {
  comparison: WorkspacePackageOutputComparison;
  sourceManifestPath: string;
}): string {
  const firstLocalDiff = flattenReleaseRelevantDiffs(options.comparison).find(
    (diff) => diff.kind !== 'remote-only',
  );
  if (firstLocalDiff === undefined) return options.sourceManifestPath;
  return path.join(
    options.comparison.localOutputDirectory,
    firstLocalDiff.relativePath,
  );
}

function addContentDiffFinding(options: {
  comparison: WorkspacePackageOutputComparison;
  context: WorkspaceComparisonContext;
  report: string;
}): void {
  const diffs = flattenReleaseRelevantDiffs(options.comparison);
  options.context.state.changedPackageNames.add(options.context.dependencyName);
  addContentHashFinding(options.context.state, {
    facts: {
      baselineTag: options.context.baseline.baselineTag,
      baselineVersion: options.context.baseline.baselineVersion,
      dependencyName: options.context.dependencyName,
      diffs,
      ignoredDiffGroups: flattenIgnoredDiffs(options.comparison),
      importerName: options.context.importerName,
      integrity: options.context.baseline.integrityResult.integrity,
      integritySource: options.context.baseline.integrityResult.source,
      kind: 'content-diff',
      localOutputDirectory: options.comparison.localOutputDirectory,
      localVersion:
        options.comparison.localVersion ??
        options.context.workspacePackage.manifest.version,
      sourceManifestPath: options.context.sourceManifestPath,
      tarballUrl: options.context.baseline.tarballUrl,
    },
    filePath: getContentDiffFilePath({
      comparison: options.comparison,
      sourceManifestPath: options.context.sourceManifestPath,
    }),
    message: `${formatDependencyLocation(options.context)}: ${options.report}`,
    packageManifestPath: options.context.sourceManifestPath,
    packageName: options.context.dependencyName,
  });
}

export async function compareWorkspacePackageRelease(
  context: WorkspaceComparisonContext,
): Promise<void> {
  const comparison = await compareWorkspaceOutput(context);
  if (comparison === null) return;
  const report = formatContentHashComparisonReport({
    baselineTag: context.baseline.baselineTag,
    baselineVersion: context.baseline.baselineVersion,
    comparison,
    dependencyName: context.dependencyName,
    importerName: context.importerName,
    localVersionFallback: context.workspacePackage.manifest.version,
  });
  if (!comparison.matchesBaseline) {
    addContentDiffFinding({ comparison, context, report });
    return;
  }
  ReleaseLogger.info(report);
}
