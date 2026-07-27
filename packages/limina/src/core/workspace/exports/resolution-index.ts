import type { ResolvedLiminaConfig } from '#config/runner';
import type { ImportAnalysisContext } from '#core/import-analysis/runner';
import {
  isNamedWorkspacePackage,
  type NamedWorkspacePackage,
  type WorkspacePackage,
} from '#core/workspace/actions';
import { collectPackageExportEntries } from './entries';
import { resolveWorkspaceExportEntry } from './execution';
import {
  oxcResolverCacheEntryBatchSize,
  recordWorkspaceExportProfileMetrics,
} from './metrics';
import { addEntryProblems } from './problems';
import { compileWorkspaceExportResolutionGroups } from './profiles';
import type {
  PackageExportEntry,
  WorkspaceExportProblem,
  WorkspaceExportsMetricsRecorder,
  WorkspaceExportsResolutionIndex,
  WorkspaceExportsResolutionProfile,
  WorkspacePackageExportResolution,
} from './types';

interface WorkspaceExportIndexState {
  diagnostics: WorkspaceExportProblem[];
  packagesWithExports: Set<string>;
  problems: string[];
  processedEntryCount: number;
  resolutionByProfilePath: Map<
    string,
    Map<string, WorkspacePackageExportResolution>
  >;
}

interface WorkspaceExportIndexContext {
  config: ResolvedLiminaConfig;
  groups: ReturnType<typeof compileWorkspaceExportResolutionGroups>;
  importAnalysis: ImportAnalysisContext;
  metrics: WorkspaceExportsMetricsRecorder | undefined;
  profiles: readonly WorkspaceExportsResolutionProfile[];
  state: WorkspaceExportIndexState;
}

function createIndexState(): WorkspaceExportIndexState {
  return {
    diagnostics: [],
    packagesWithExports: new Set<string>(),
    problems: [],
    processedEntryCount: 0,
    resolutionByProfilePath: new Map(),
  };
}

function hasPackageExports(workspacePackage: NamedWorkspacePackage): boolean {
  return workspacePackage.manifest.exports !== undefined;
}

function clearOxcResolverCaches(importAnalysis: ImportAnalysisContext): void {
  importAnalysis.clearOxcResolverCaches?.();
}

function clearOxcCachesAtBatchBoundary(
  context: WorkspaceExportIndexContext,
): void {
  const count = context.state.processedEntryCount;
  if (count % oxcResolverCacheEntryBatchSize !== 0) return;
  clearOxcResolverCaches(context.importAnalysis);
}

function appendCollectedProblems(options: {
  diagnostics: readonly WorkspaceExportProblem[];
  problems: readonly string[];
  state: WorkspaceExportIndexState;
}): void {
  options.state.diagnostics.push(...options.diagnostics);
  options.state.problems.push(...options.problems);
}

function resolveEntry(
  context: WorkspaceExportIndexContext,
  entry: PackageExportEntry,
): void {
  context.state.processedEntryCount += 1;
  const outcome = resolveWorkspaceExportEntry({
    entry,
    groups: context.groups,
    importAnalysis: context.importAnalysis,
    metrics: context.metrics,
    profiles: context.profiles,
    resolutionByProfilePath: context.state.resolutionByProfilePath,
  });
  addEntryProblems({
    config: context.config,
    diagnostics: context.state.diagnostics,
    entry,
    hasOxcResolution: outcome.hasOxcResolution,
    hasTypeScriptResolution: outcome.hasTypeScriptResolution,
    problems: context.state.problems,
    profiles: context.profiles,
  });
  clearOxcCachesAtBatchBoundary(context);
}

async function processPackage(
  context: WorkspaceExportIndexContext,
  workspacePackage: NamedWorkspacePackage,
): Promise<void> {
  if (!hasPackageExports(workspacePackage)) return;
  context.state.packagesWithExports.add(workspacePackage.name);
  const collected = await collectPackageExportEntries(workspacePackage);
  appendCollectedProblems({ ...collected, state: context.state });
  for (const entry of collected.entries) resolveEntry(context, entry);
}

function createIndexResult(
  state: WorkspaceExportIndexState,
): WorkspaceExportsResolutionIndex {
  return {
    diagnostics: state.diagnostics,
    get: (profileConfigPath, specifier) =>
      state.resolutionByProfilePath.get(profileConfigPath)?.get(specifier) ??
      null,
    hasExports: (packageName) => state.packagesWithExports.has(packageName),
    problems: state.problems,
  };
}

function recordProfileMetrics(options: {
  groups: ReturnType<typeof compileWorkspaceExportResolutionGroups>;
  metrics: WorkspaceExportsMetricsRecorder | undefined;
}): void {
  if (options.metrics === undefined) return;
  recordWorkspaceExportProfileMetrics({
    groups: options.groups,
    metrics: options.metrics,
  });
}

export async function createWorkspaceExportsResolutionIndex(options: {
  config: ResolvedLiminaConfig;
  importAnalysis: ImportAnalysisContext;
  metrics?: WorkspaceExportsMetricsRecorder;
  packages: WorkspacePackage[];
  profiles: WorkspaceExportsResolutionProfile[];
}): Promise<WorkspaceExportsResolutionIndex> {
  const groups = compileWorkspaceExportResolutionGroups(options.profiles);
  const state = createIndexState();
  const context: WorkspaceExportIndexContext = {
    config: options.config,
    groups,
    importAnalysis: options.importAnalysis,
    metrics: options.metrics,
    profiles: options.profiles,
    state,
  };
  recordProfileMetrics({ groups, metrics: options.metrics });
  for (const workspacePackage of options.packages.filter(
    isNamedWorkspacePackage,
  )) {
    await processPackage(context, workspacePackage);
  }
  clearOxcResolverCaches(options.importAnalysis);
  return createIndexResult(state);
}
