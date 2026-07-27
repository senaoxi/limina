import type { ResolvedLiminaConfig } from '#config/runner';
import {
  formatExportTargets,
  getDeclarationCandidatePaths,
  getDisplayPath,
  getRuntimeCandidatePaths,
} from './resolution';
import type {
  PackageExportEntry,
  WorkspaceExportProblem,
  WorkspaceExportsResolutionProfile,
} from './types';

function addProblemList(
  lines: string[],
  label: string,
  values: readonly string[],
): void {
  lines.push(`  ${label}:`);
  const visibleValues = values.length > 0 ? values : ['<none>'];
  for (const value of visibleValues) lines.push(`    - ${value}`);
}

function formatCheckedProfile(
  config: ResolvedLiminaConfig,
  profile: WorkspaceExportsResolutionProfile,
): string {
  const configPath = getDisplayPath(config, profile.configPath);
  const checkerPresets = profile.checkerPresets.join(', ');
  return checkerPresets.length > 0
    ? `${configPath} (${checkerPresets})`
    : configPath;
}

function getWorkspaceExportFix(): string {
  return 'either create the missing exported entry, or update/remove package.json main/types/exports so the package public surface matches the files that are actually built.';
}

function appendExpectedCandidates(options: {
  expectedCandidates: readonly string[];
  expectedCandidatesLabel: string;
  lines: string[];
}): void {
  if (options.expectedCandidates.length === 0) return;
  addProblemList(
    options.lines,
    options.expectedCandidatesLabel,
    options.expectedCandidates,
  );
}

function createWorkspaceExportProblem(options: {
  config: ResolvedLiminaConfig;
  entry: PackageExportEntry;
  expectedCandidates: readonly string[];
  expectedCandidatesLabel: string;
  profiles: readonly WorkspaceExportsResolutionProfile[];
  reason: string;
  resolver: string;
  title: string;
}): WorkspaceExportProblem {
  const lines = [
    options.title,
    '  check: graph:check workspace exports preflight',
    `  package: ${options.entry.packageName}`,
    `  package.json: ${getDisplayPath(
      options.config,
      options.entry.packageJsonPath,
    )}`,
    `  export: ${options.entry.subpath}`,
    `  specifier: ${options.entry.specifier}`,
  ];
  addProblemList(
    lines,
    'declared targets',
    formatExportTargets(options.entry.targets),
  );
  lines.push(`  resolver: ${options.resolver}`);
  addProblemList(
    lines,
    'checked profiles',
    options.profiles.map((profile) =>
      formatCheckedProfile(options.config, profile),
    ),
  );
  appendExpectedCandidates({ ...options, lines });
  lines.push(
    `  reason: ${options.reason}`,
    `  fix: ${getWorkspaceExportFix()}`,
  );
  return {
    detailLines: lines,
    fix: getWorkspaceExportFix(),
    packageJsonPath: options.entry.packageJsonPath,
    packageName: options.entry.packageName,
    reason: options.reason,
    subpath: options.entry.subpath,
    title: options.title,
  };
}

function addDiagnostic(options: {
  diagnostic: WorkspaceExportProblem;
  diagnostics: WorkspaceExportProblem[];
  problems: string[];
}): void {
  options.diagnostics.push(options.diagnostic);
  options.problems.push(options.diagnostic.detailLines.join('\n'));
}

function createTypeScriptProblem(options: {
  config: ResolvedLiminaConfig;
  entry: PackageExportEntry;
  profiles: readonly WorkspaceExportsResolutionProfile[];
}): WorkspaceExportProblem {
  return createWorkspaceExportProblem({
    config: options.config,
    entry: options.entry,
    expectedCandidates: getDeclarationCandidatePaths({
      config: options.config,
      entry: options.entry,
    }),
    expectedCandidatesLabel: 'expected declaration candidates',
    profiles: options.profiles,
    reason:
      'package.json#exports/types/main do not resolve to a declaration entry for any active checker profile.',
    resolver: 'TypeScript declaration resolver',
    title:
      'Workspace package export has no TypeScript declaration-context resolution',
  });
}

function createOxcProblem(options: {
  config: ResolvedLiminaConfig;
  entry: PackageExportEntry;
  profiles: readonly WorkspaceExportsResolutionProfile[];
}): WorkspaceExportProblem {
  return createWorkspaceExportProblem({
    config: options.config,
    entry: options.entry,
    expectedCandidates: getRuntimeCandidatePaths({
      config: options.config,
      entry: options.entry,
    }),
    expectedCandidatesLabel: 'expected runtime candidates',
    profiles: options.profiles,
    reason:
      'package.json#exports declares this public entry, but no active checker profile can resolve it.',
    resolver: 'Oxc runtime resolver',
    title: 'Workspace package export points to an unresolved public entry',
  });
}

interface EntryProblemOptions {
  config: ResolvedLiminaConfig;
  diagnostics: WorkspaceExportProblem[];
  entry: PackageExportEntry;
  hasOxcResolution: boolean;
  hasTypeScriptResolution: boolean;
  problems: string[];
  profiles: readonly WorkspaceExportsResolutionProfile[];
}

function addTypeScriptProblem(options: EntryProblemOptions): void {
  if (options.hasTypeScriptResolution || options.hasOxcResolution) return;
  addDiagnostic({
    diagnostic: createTypeScriptProblem(options),
    diagnostics: options.diagnostics,
    problems: options.problems,
  });
}

function addOxcProblem(options: EntryProblemOptions): void {
  if (options.hasOxcResolution) return;
  addDiagnostic({
    diagnostic: createOxcProblem(options),
    diagnostics: options.diagnostics,
    problems: options.problems,
  });
}

export function addEntryProblems(options: EntryProblemOptions): void {
  addTypeScriptProblem(options);
  addOxcProblem(options);
}
