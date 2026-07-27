import type { CheckerProjectParseContext } from '#checkers';
import type { ImportAnalysisMetricsRecorder } from '#core/import-analysis/runner';
import type ts from 'typescript';

export interface WorkspaceExportsResolutionProfile {
  checkerPresets: CheckerProjectParseContext['checkerPresets'];
  configPath: string;
  extensions: string[];
  options: ts.CompilerOptions;
  resolverConfigPath: string;
}

export interface WorkspacePackageExportResolution {
  hasTypeScriptStableEntry: boolean;
  oxcResolvedFileName: string | null;
  packageName: string;
  specifier: string;
  subpath: string;
  typeScriptResolvedFileName: string | null;
}

export interface WorkspaceExportProblem {
  readonly detailLines: readonly string[];
  readonly fix?: string;
  readonly packageJsonPath: string;
  readonly packageName: string;
  readonly reason: string;
  readonly subpath: string;
  readonly title: string;
}

export interface WorkspaceExportsResolutionIndex {
  diagnostics: WorkspaceExportProblem[];
  get: (
    profileConfigPath: string,
    specifier: string,
  ) => WorkspacePackageExportResolution | null;
  hasExports: (packageName: string) => boolean;
  problems: string[];
}

type ImportAnalysisMetricMeasurement = Parameters<
  ImportAnalysisMetricsRecorder['record']
>[0];

export interface WorkspaceExportsMetricsRecorder
  extends ImportAnalysisMetricsRecorder {
  record(
    measurement:
      | ImportAnalysisMetricMeasurement
      | {
          readonly count?: number;
          readonly kind?: string;
          readonly name:
            | 'workspace-export-grouped-oxc-execution'
            | 'workspace-export-grouped-typescript-execution'
            | 'workspace-export-oxc-resolution'
            | 'workspace-export-oxc-semantic-profile-count'
            | 'workspace-export-profile-count'
            | 'workspace-export-resolution-request'
            | 'workspace-export-result-expansion'
            | 'workspace-export-typescript-profile-fallback'
            | 'workspace-export-typescript-resolution'
            | 'workspace-export-typescript-semantic-profile-count';
          readonly provider?: string;
        },
  ): void;
}

export interface PackageExportEntry {
  hasExplicitExports: boolean;
  isNamedWorkspacePackage: boolean;
  packageDirectory: string;
  packageJsonPath: string;
  packageName: string;
  specifier: string;
  subpath: string;
  targets: readonly string[];
}

export interface CollectedPackageExportEntries {
  diagnostics: WorkspaceExportProblem[];
  entries: PackageExportEntry[];
  problems: string[];
}
