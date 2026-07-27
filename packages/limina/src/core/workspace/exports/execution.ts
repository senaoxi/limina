import type { ImportAnalysisContext } from '#core/import-analysis/runner';
import {
  recordGroupedOxcExecution,
  recordGroupedTypeScriptExecution,
  recordOriginalResultExpansion,
} from './metrics';
import {
  getWorkspaceExportSelfNameContext,
  type WorkspaceExportResolutionGroups,
} from './profiles';
import {
  getEffectiveOxcResolvedFileName,
  resolveOxcExport,
  resolveTypeScriptExport,
} from './resolution';
import type {
  PackageExportEntry,
  WorkspaceExportsMetricsRecorder,
  WorkspaceExportsResolutionProfile,
  WorkspacePackageExportResolution,
} from './types';

const typeScriptRuntimeModulePattern = /\.(?:cjs|mjs|jsx|js)$/u;

export interface EntryResolutionOutcome {
  hasOxcResolution: boolean;
  hasTypeScriptResolution: boolean;
}

interface ResolutionBuffers {
  oxc: (string | null)[];
  typeScript: (string | null)[];
}

function createResolutionBuffers(profileCount: number): ResolutionBuffers {
  return {
    oxc: Array.from({ length: profileCount }).fill(null) as (string | null)[],
    typeScript: Array.from({ length: profileCount }).fill(null) as (
      | string
      | null
    )[],
  };
}

function assignMembers(
  results: (string | null)[],
  memberIndexes: readonly number[],
  resolved: string | null,
): void {
  for (const memberIndex of memberIndexes) results[memberIndex] = resolved;
}

function getRepresentativeProfile(options: {
  profiles: readonly WorkspaceExportsResolutionProfile[];
  representativeIndex: number;
}): WorkspaceExportsResolutionProfile | undefined {
  return options.profiles[options.representativeIndex];
}

function resolveGroupedTypeScript(options: {
  buffers: ResolutionBuffers;
  entry: PackageExportEntry;
  groups: WorkspaceExportResolutionGroups;
  importAnalysis: ImportAnalysisContext;
  metrics: WorkspaceExportsMetricsRecorder | undefined;
  profiles: readonly WorkspaceExportsResolutionProfile[];
}): void {
  for (const plan of options.groups.typescriptGroups.values()) {
    const profile = getRepresentativeProfile({
      profiles: options.profiles,
      representativeIndex: plan.representativeIndex,
    });
    if (profile === undefined) continue;
    recordGroupedTypeScriptExecution(options.metrics);
    const resolved = resolveTypeScriptExport({
      entry: options.entry,
      importAnalysis: options.importAnalysis,
      profile,
    });
    assignMembers(options.buffers.typeScript, plan.memberIndexes, resolved);
  }
}

function resolveOriginalTypeScript(options: {
  buffers: ResolutionBuffers;
  entry: PackageExportEntry;
  groups: WorkspaceExportResolutionGroups;
  importAnalysis: ImportAnalysisContext;
  metrics: WorkspaceExportsMetricsRecorder | undefined;
}): void {
  for (const compiled of options.groups.compiledOriginals) {
    recordGroupedTypeScriptExecution(options.metrics);
    options.buffers.typeScript[compiled.originalIndex] =
      resolveTypeScriptExport({
        entry: options.entry,
        importAnalysis: options.importAnalysis,
        profile: compiled.original,
      });
  }
}

function resolveTypeScriptResults(options: {
  buffers: ResolutionBuffers;
  entry: PackageExportEntry;
  groups: WorkspaceExportResolutionGroups;
  importAnalysis: ImportAnalysisContext;
  metrics: WorkspaceExportsMetricsRecorder | undefined;
  profiles: readonly WorkspaceExportsResolutionProfile[];
}): void {
  const selfNameContext = getWorkspaceExportSelfNameContext({
    entry: options.entry,
  });
  if (selfNameContext.eligible) resolveGroupedTypeScript(options);
  else resolveOriginalTypeScript(options);
}

function resolveOxcResults(options: {
  buffers: ResolutionBuffers;
  entry: PackageExportEntry;
  groups: WorkspaceExportResolutionGroups;
  importAnalysis: ImportAnalysisContext;
  metrics: WorkspaceExportsMetricsRecorder | undefined;
  profiles: readonly WorkspaceExportsResolutionProfile[];
}): void {
  for (const plan of options.groups.oxcGroups.values()) {
    const profile = getRepresentativeProfile({
      profiles: options.profiles,
      representativeIndex: plan.representativeIndex,
    });
    if (profile === undefined) continue;
    recordGroupedOxcExecution(options.metrics);
    const resolved = resolveOxcExport({
      entry: options.entry,
      importAnalysis: options.importAnalysis,
      profile,
    });
    assignMembers(options.buffers.oxc, plan.memberIndexes, resolved);
  }
}

function getProfileResolutionMap(options: {
  profileConfigPath: string;
  resolutionByProfilePath: Map<
    string,
    Map<string, WorkspacePackageExportResolution>
  >;
}): Map<string, WorkspacePackageExportResolution> {
  const existing = options.resolutionByProfilePath.get(
    options.profileConfigPath,
  );
  if (existing !== undefined) return existing;
  const created = new Map<string, WorkspacePackageExportResolution>();
  options.resolutionByProfilePath.set(options.profileConfigPath, created);
  return created;
}

function isTypeScriptStableEntry(filePath: string | null): boolean {
  if (filePath === null) return false;
  return !typeScriptRuntimeModulePattern.test(filePath);
}

function createProfileResolution(options: {
  entry: PackageExportEntry;
  oxcResolvedFileName: string | null;
  typeScriptResolvedFileName: string | null;
}): WorkspacePackageExportResolution {
  return {
    hasTypeScriptStableEntry: isTypeScriptStableEntry(
      options.typeScriptResolvedFileName,
    ),
    oxcResolvedFileName: options.oxcResolvedFileName,
    packageName: options.entry.packageName,
    specifier: options.entry.specifier,
    subpath: options.entry.subpath,
    typeScriptResolvedFileName: options.typeScriptResolvedFileName,
  };
}

function mergeResolutionOutcome(
  outcome: EntryResolutionOutcome,
  resolution: WorkspacePackageExportResolution,
): void {
  if (resolution.typeScriptResolvedFileName !== null) {
    outcome.hasTypeScriptResolution = true;
  }
  if (resolution.oxcResolvedFileName !== null) {
    outcome.hasOxcResolution = true;
  }
}

function getBufferedResult(
  results: readonly (string | null)[],
  index: number,
): string | null {
  return results[index] ?? null;
}

function expandOriginalResults(options: {
  buffers: ResolutionBuffers;
  entry: PackageExportEntry;
  groups: WorkspaceExportResolutionGroups;
  metrics: WorkspaceExportsMetricsRecorder | undefined;
  resolutionByProfilePath: Map<
    string,
    Map<string, WorkspacePackageExportResolution>
  >;
}): EntryResolutionOutcome {
  const outcome = {
    hasOxcResolution: false,
    hasTypeScriptResolution: false,
  };
  for (const compiled of options.groups.compiledOriginals) {
    recordOriginalResultExpansion(options.metrics);
    const typeScriptResolvedFileName = getBufferedResult(
      options.buffers.typeScript,
      compiled.originalIndex,
    );
    const rawOxcResolvedFileName = getBufferedResult(
      options.buffers.oxc,
      compiled.originalIndex,
    );
    const resolution = createProfileResolution({
      entry: options.entry,
      oxcResolvedFileName: getEffectiveOxcResolvedFileName({
        oxcResolvedFileName: rawOxcResolvedFileName,
        typeScriptResolvedFileName,
      }),
      typeScriptResolvedFileName,
    });
    const profileResolutions = getProfileResolutionMap({
      profileConfigPath: compiled.originalConfigPath,
      resolutionByProfilePath: options.resolutionByProfilePath,
    });
    profileResolutions.set(options.entry.specifier, resolution);
    mergeResolutionOutcome(outcome, resolution);
  }
  return outcome;
}

export function resolveWorkspaceExportEntry(options: {
  entry: PackageExportEntry;
  groups: WorkspaceExportResolutionGroups;
  importAnalysis: ImportAnalysisContext;
  metrics: WorkspaceExportsMetricsRecorder | undefined;
  profiles: readonly WorkspaceExportsResolutionProfile[];
  resolutionByProfilePath: Map<
    string,
    Map<string, WorkspacePackageExportResolution>
  >;
}): EntryResolutionOutcome {
  const buffers = createResolutionBuffers(options.profiles.length);
  resolveTypeScriptResults({ ...options, buffers });
  resolveOxcResults({ ...options, buffers });
  return expandOriginalResults({ ...options, buffers });
}
