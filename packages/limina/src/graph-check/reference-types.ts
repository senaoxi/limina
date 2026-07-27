import type { ResolvedLiminaConfig } from '#config/runner';
import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
import type { ImportAnalysisContext } from '#core/import-analysis/runner';
import type { ImportRecord, ProjectInfo } from '#core/import-graph/context';
import type { ImporterInfo, WorkspacePackage } from '#core/workspace/actions';
import type {
  ManagedOutputDeclarationLookup,
  ManagedOutputDeclarationProvider,
} from '../core/import-graph/managed-output-provider';
import type {
  WorkspaceExportsResolutionIndex,
  WorkspacePackageExportResolution,
} from '../core/workspace/exports';
import type { WorkspaceLookupIndex } from '../core/workspace/lookup';
import type { GraphFinding } from './findings';
import type { NormalizedGraphRules } from './rules';

export interface ReferenceExpectation {
  importRecords: ImportRecord[];
  targetProjectPath: string;
}

export type ExpectedReferencesByProjectPath = Map<
  string,
  Map<string, ReferenceExpectation>
>;

export interface ExpectedReferenceCollectionOptions {
  config: ResolvedLiminaConfig;
  fileOwnerLookup: Map<string, string[]>;
  generatedGraph: GeneratedTsconfigGraphResult;
  graphRules: NormalizedGraphRules;
  importAnalysis: ImportAnalysisContext;
  managedOutputLookup: ManagedOutputDeclarationLookup;
  packages: WorkspacePackage[];
  projectCheckerNamesByPath: Map<string, string>;
  findings: GraphFinding[];
  projectPaths: string[];
  projects: ProjectInfo[];
  projectsByPath: Map<string, ProjectInfo>;
  selectedProjectPaths?: Set<string>;
  workspaceExports: WorkspaceExportsResolutionIndex;
  workspaceLookup: WorkspaceLookupIndex;
}

export interface ExpectedReferenceCollectionContext
  extends ExpectedReferenceCollectionOptions {
  expectedReferencesByProjectPath: ExpectedReferencesByProjectPath;
}

export interface GraphImportResolution {
  graphResolvedFilePath: string;
  importer: ImporterInfo | null;
  managedOutputAttribution: ManagedOutputDeclarationProvider | null;
  managedOutputTargetProjectPath: string | null;
  resolvedFilePath: string;
  targetPackage: WorkspacePackage | null;
  targetPackageForGraph: WorkspacePackage | null;
  targetWorkspacePackageForResolved: WorkspacePackage | null;
  workspaceExportResolution: WorkspacePackageExportResolution | null;
}
