import type { CheckerProjectParseContext } from '#checkers';
import type { CheckerPreset } from '#config/runner';

export type JsonObject = Record<string, unknown>;

export interface ReferencePathInfo {
  rawPath: string;
  resolvedPath: string;
}

export interface TsconfigGraphRouteDiagnostic {
  readonly detailLines: readonly string[];
  readonly filePath?: string;
  readonly reason: string;
  readonly title: string;
}

export interface ReferencePathCollection {
  diagnostics: TsconfigGraphRouteDiagnostic[];
  problems: string[];
  references: ReferencePathInfo[];
}

export interface CollectGraphProjectPathsResult {
  diagnostics: TsconfigGraphRouteDiagnostic[];
  problems: string[];
  projectPaths: string[];
}

export interface CheckerGraphProjectRoute {
  checkerName: string;
  checkerPreset: CheckerPreset;
  extensions: string[];
  projectPaths: string[];
  rootConfigPath: string;
}

export interface CheckerGraphRouteDiagnostic {
  readonly checkerName: string;
  readonly detailLines: readonly string[];
  readonly filePath?: string;
  readonly reason: string;
  readonly title: string;
}

export interface CollectCheckerGraphProjectRoutesResult {
  diagnostics: CheckerGraphRouteDiagnostic[];
  problems: string[];
  routes: CheckerGraphProjectRoute[];
}

export interface CollectSourceGraphProjectExtensionsResult {
  diagnostics: CheckerGraphRouteDiagnostic[];
  problems: string[];
  projectContextsByPath: Map<string, CheckerProjectParseContext>;
  projectExtensionsByPath: Map<string, string[]>;
}

export interface CheckerRouteMetricsRecorder {
  record(measurement: {
    readonly count?: number;
    readonly kind?: string;
    readonly name: 'checker-route-projection' | 'checker-route-traversal';
    readonly provider?: string;
  }): void;
}

export type CheckerEntryAvailability =
  | 'available'
  | 'missing-config'
  | 'missing-entry';

export interface CheckerRouteTraversalSnapshot {
  readonly diagnostics: readonly TsconfigGraphRouteDiagnostic[];
  readonly normalizedRootConfigPath: string;
  readonly problems: readonly string[];
  readonly projectPaths: readonly string[];
}

export interface CheckerRouteSnapshot {
  readonly checkerName: string;
  readonly checkerPreset: CheckerPreset;
  readonly entryAvailability: CheckerEntryAvailability;
  readonly extensions: readonly string[];
  readonly normalizedRootConfigPath?: string;
  readonly rootConfigPath?: string;
  readonly supportsSourceGraph: boolean;
  readonly traversal?: CheckerRouteTraversalSnapshot;
}

export interface CheckerRouteSnapshotCollection {
  readonly checkers: readonly CheckerRouteSnapshot[];
  readonly generatedFiles?: ReadonlyMap<string, string>;
  readonly metrics?: CheckerRouteMetricsRecorder;
  readonly traversalCount: number;
  readonly uniqueValidCheckerEntryRoots: number;
}
