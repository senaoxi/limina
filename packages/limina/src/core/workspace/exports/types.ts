export interface WorkspaceExportProblem {
  readonly detailLines: readonly string[];
  readonly fix?: string;
  readonly packageJsonPath: string;
  readonly packageName: string;
  readonly reason: string;
  readonly subpath: string;
  readonly title: string;
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
