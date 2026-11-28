import type { ResolvedLiminaConfig } from '#config/runner';
import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
import type { ImportRecord, ProjectInfo } from '#core/import-graph/context';
import type { ImporterInfo, WorkspacePackage } from '#core/workspace/actions';
import type { PreparedGraphProjectDependencies } from '../core/facts/graph-projects';
import type {
  ManagedOutputDeclarationLookup,
  ManagedOutputDeclarationProvider,
} from '../core/import-graph/managed-output-provider';
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
  managedOutputLookup: ManagedOutputDeclarationLookup;
  packages: WorkspacePackage[];
  preparedProjectDependencies: readonly PreparedGraphProjectDependencies[];
  projectCheckerNamesByPath: Map<string, string>;
  findings: GraphFinding[];
  projectPaths: string[];
  projects: ProjectInfo[];
  projectsByPath: Map<string, ProjectInfo>;
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
}
