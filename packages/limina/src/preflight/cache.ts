import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
import type {
  CheckerRouteSnapshotCollection,
  CollectCheckerGraphProjectRoutesResult,
  CollectSourceGraphProjectExtensionsResult,
} from '#core/tsconfig/actions';
import type {
  ImporterInfo,
  PackageOwner,
  WorkspacePackage,
} from '#core/workspace/actions';
import type { WorkspaceDependencyDeclaration } from '../core/packages/authority';
import type { WorkspaceLookupIndex } from '../core/workspace/lookup';
import type { WorkspaceRegionBoundary } from '../core/workspace/regions';
import type { ValidatedWorkspaceContext } from '../core/workspace/validated-context';
import type { MaterializationSlot } from './materialization';

export class PreflightGenerationCache {
  checkerEntryProjectRoutes?: Promise<CollectCheckerGraphProjectRoutesResult>;
  checkerRouteSnapshot?: Promise<CheckerRouteSnapshotCollection>;
  expectedSourceFiles?: Promise<Set<string>>;
  generatedGraph?: Promise<GeneratedTsconfigGraphResult>;
  graphProjectRoutes?: Promise<CollectCheckerGraphProjectRoutesResult>;
  importers?: Promise<ImporterInfo[]>;
  materializationSlot: MaterializationSlot;
  packageOwners?: Promise<PackageOwner[]>;
  rawWorkspacePackages?: Promise<WorkspacePackage[]>;
  sourceGraphProjectExtensions?: Promise<CollectSourceGraphProjectExtensionsResult>;
  validatedWorkspaceContext?: Promise<ValidatedWorkspaceContext>;
  workspaceDependencies?: Promise<WorkspaceDependencyDeclaration[]>;
  workspaceLookup?: Promise<WorkspaceLookupIndex>;
  workspacePackages?: Promise<WorkspacePackage[]>;
  workspaceRegionBoundaries?: Promise<WorkspaceRegionBoundary[]>;

  constructor(generation: number) {
    this.materializationSlot = { generation };
  }
}
