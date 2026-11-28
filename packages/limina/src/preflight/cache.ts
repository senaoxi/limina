import type { CheckerSelectionResolution } from '#core';
import type {
  GeneratedTsconfigGraphResult,
  ProducerBuildPlan,
} from '#core/build-graph/runner';
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
import type { SourceGovernanceFacts } from '../core/facts/source-projects';
import type { WorkspaceDependencyDeclaration } from '../core/packages/authority';
import type { WorkspaceLookupIndex } from '../core/workspace/lookup';
import type { WorkspaceRegionBoundary } from '../core/workspace/regions';
import type { ValidatedWorkspaceContext } from '../core/workspace/validated-context';
import type { MaterializationSlot } from './materialization';

export class PreflightGenerationCache {
  checkerEntryProjectRoutes?: Promise<CollectCheckerGraphProjectRoutesResult>;
  checkerRouteSnapshot?: Promise<CheckerRouteSnapshotCollection>;
  coreAnalysis?: Promise<CheckerSelectionResolution>;
  expectedSourceFiles?: Promise<Set<string>>;
  generatedGraph?: Promise<GeneratedTsconfigGraphResult>;
  producerBuildPlan?: Promise<ProducerBuildPlan>;
  producerMaterializationSlot: MaterializationSlot;
  graphProjectRoutes?: Promise<CollectCheckerGraphProjectRoutesResult>;
  importers?: Promise<ImporterInfo[]>;
  materializationSlot: MaterializationSlot;
  packageOwners?: Promise<PackageOwner[]>;
  rawWorkspacePackages?: Promise<WorkspacePackage[]>;
  sourceGovernance?: Promise<SourceGovernanceFacts>;
  sourceGraphProjectExtensions?: Promise<CollectSourceGraphProjectExtensionsResult>;
  validatedWorkspaceContext?: Promise<ValidatedWorkspaceContext>;
  workspaceDependencies?: Promise<WorkspaceDependencyDeclaration[]>;
  workspaceLookup?: Promise<WorkspaceLookupIndex>;
  workspacePackages?: Promise<WorkspacePackage[]>;
  workspaceRegionBoundaries?: Promise<WorkspaceRegionBoundary[]>;

  constructor(
    generation: number,
    materializationSlot: MaterializationSlot = { generation },
  ) {
    this.materializationSlot = materializationSlot;
    this.producerMaterializationSlot = { generation };
  }
}
