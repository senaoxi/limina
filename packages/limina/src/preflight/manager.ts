import type {
  PackageCheckToolSelection,
  ResolvedLiminaConfig,
} from '#config/runner';
import { type AnalysisProviderSet, createAnalysisProviders } from '#core';
import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
import type { ImportAnalysisContext } from '#core/import-analysis/runner';
import {
  type CheckerRouteSnapshotCollection,
  type CollectCheckerGraphProjectRoutesResult,
  collectCheckerRouteSnapshot,
  type CollectSourceGraphProjectExtensionsResult,
  projectCheckerEntryProjectRoutes,
  projectGraphProjectRoutes,
  projectSourceGraphProjectExtensions,
} from '#core/tsconfig/actions';
import type {
  ImporterInfo,
  PackageOwner,
  WorkspacePackage,
} from '#core/workspace/actions';
import {
  type AnalysisMetricsRecorder,
  type AnalysisRun,
  createAnalysisRun,
  createNoopMetricsRecorder,
} from '../application/analysis/analysis-run';
import { materializeGeneratedArtifactPlan } from '../core/build-graph/materializer';
import type { WorkspaceDependencyDeclaration } from '../core/packages/authority';
import type { WorkspaceLookupIndex } from '../core/workspace/lookup';
import type { WorkspaceRegionBoundary } from '../core/workspace/regions';
import type {
  ValidatedWorkspaceContext,
  WorkspaceRegionPathIndex,
} from '../core/workspace/validated-context';
import {
  createLiminaArtifactNamespace,
  type LiminaArtifactNamespace,
} from '../domain/artifacts/namespace';
import { identifier } from '../domain/shared/identifiers';
import {
  createPackageEntrySelectionPlan,
  type PackageEntrySelectionPlan,
} from '../package-check/entry-selection';
import { collectExpectedSourceFiles } from '../proof/source-files';
import { registerPreflightGenerationAdvancer } from './generation';

export interface LiminaPreflightManagerOptions {
  config: ResolvedLiminaConfig;
  generatedGraphProvider?: () => Promise<GeneratedTsconfigGraphResult>;
  metrics?: AnalysisMetricsRecorder;
  providers?: AnalysisProviderSet;
  signal?: AbortSignal;
}

export interface PackageEntryPlanOptions {
  cwd: string;
  packageNames?: readonly string[];
  requireCwdPackageMatch: boolean;
  tool?: PackageCheckToolSelection;
}

export interface PreflightCapableOptions {
  generatedGraphProvider?: () => Promise<GeneratedTsconfigGraphResult>;
  preflight?: LiminaPreflightManager;
  providers?: AnalysisProviderSet;
}

export interface MaterializationReceipt {
  changed: boolean;
  generation: number;
  graph: GeneratedTsconfigGraphResult;
}

interface MaterializationSlot {
  generation: number;
  inFlight?: Promise<MaterializationReceipt>;
  receipt?: MaterializationReceipt;
}

/**
 * Command composition boundary for the current repository generation.
 *
 * It owns no generic cache and cannot resolve arbitrary capabilities. Each
 * field represents one named preparation result. An external command advances
 * the generation and replaces the concrete provider set instead of mutating
 * cached domain data in place.
 */
export class LiminaPreflightManager {
  artifactNamespace: LiminaArtifactNamespace;
  readonly config: ResolvedLiminaConfig;
  providers: AnalysisProviderSet;
  run: AnalysisRun;

  readonly #generatedGraphProvider:
    | (() => Promise<GeneratedTsconfigGraphResult>)
    | undefined;
  readonly #metrics: AnalysisMetricsRecorder;
  readonly #profilingMetrics: AnalysisMetricsRecorder | undefined;
  readonly #signal: AbortSignal;
  #checkerEntryProjectRoutesPromise:
    | Promise<CollectCheckerGraphProjectRoutesResult>
    | undefined;
  #checkerRouteSnapshotPromise:
    | Promise<CheckerRouteSnapshotCollection>
    | undefined;
  #expectedSourceFilesPromise: Promise<Set<string>> | undefined;
  #generatedGraphPromise: Promise<GeneratedTsconfigGraphResult> | undefined;
  #generation = 0;
  #graphProjectRoutesPromise:
    | Promise<CollectCheckerGraphProjectRoutesResult>
    | undefined;
  #importersPromise: Promise<ImporterInfo[]> | undefined;
  #packageOwnersPromise: Promise<PackageOwner[]> | undefined;
  #rawWorkspacePackagesPromise: Promise<WorkspacePackage[]> | undefined;
  #sourceGraphProjectExtensionsPromise:
    | Promise<CollectSourceGraphProjectExtensionsResult>
    | undefined;
  #workspaceDependenciesPromise:
    | Promise<WorkspaceDependencyDeclaration[]>
    | undefined;
  #workspaceLookupPromise: Promise<WorkspaceLookupIndex> | undefined;
  #workspacePackagesPromise: Promise<WorkspacePackage[]> | undefined;
  #validatedWorkspaceContextPromise:
    | Promise<ValidatedWorkspaceContext>
    | undefined;
  #workspaceRegionBoundariesPromise:
    | Promise<WorkspaceRegionBoundary[]>
    | undefined;
  #materializationSlot: MaterializationSlot = { generation: 0 };

  constructor(options: LiminaPreflightManagerOptions) {
    this.config = options.config;
    this.#generatedGraphProvider = options.generatedGraphProvider;
    this.#metrics = options.metrics ?? createNoopMetricsRecorder();
    this.#profilingMetrics = options.metrics;
    this.#signal = options.signal ?? new AbortController().signal;
    this.artifactNamespace =
      options.providers?.artifactNamespace ??
      createLiminaArtifactNamespace({
        generation: 0,
        rootDir: options.config.rootDir,
      });
    this.providers =
      options.providers ??
      createAnalysisProviders(
        options.config,
        this.artifactNamespace,
        this.#profilingMetrics,
      );
    this.run = this.#createRun();
    registerPreflightGenerationAdvancer(this, () =>
      this.#startNextGeneration(),
    );
  }

  get profilingMetrics(): AnalysisMetricsRecorder | undefined {
    return this.#profilingMetrics;
  }

  ensureGeneratedGraph(): Promise<GeneratedTsconfigGraphResult> {
    if (!this.#generatedGraphPromise) {
      const providers = this.providers;
      const generatedGraphProvider = this.#generatedGraphProvider;
      this.#generatedGraphPromise = this.ensureWorkspaceValidated().then(
        () => generatedGraphProvider?.() ?? providers.buildGraph.getGraph(),
      );
    }
    return this.#generatedGraphPromise;
  }

  ensureWorkspaceValidated(): Promise<ValidatedWorkspaceContext> {
    this.#validatedWorkspaceContextPromise ??=
      this.providers.workspace.getValidatedContext();
    return this.#validatedWorkspaceContextPromise;
  }

  ensureGeneratedArtifactsMaterialized(): Promise<MaterializationReceipt> {
    const slot = this.#materializationSlot;
    const artifactNamespace = this.artifactNamespace;

    if (slot.receipt) {
      return Promise.resolve(slot.receipt);
    }

    if (slot.inFlight) {
      return slot.inFlight;
    }

    const inFlight = this.ensureGeneratedGraph().then(async (graph) => {
      await materializeGeneratedArtifactPlan(
        artifactNamespace,
        graph.artifactPlan,
        { metrics: this.run.metrics },
      );

      return {
        changed: graph.changed,
        generation: slot.generation,
        graph,
      } satisfies MaterializationReceipt;
    });

    slot.inFlight = inFlight;

    return inFlight.then(
      (receipt) => {
        if (
          this.#materializationSlot === slot &&
          slot.inFlight === inFlight &&
          slot.generation === receipt.generation
        ) {
          slot.receipt = receipt;
          slot.inFlight = undefined;
        }

        return receipt;
      },
      (error: unknown) => {
        if (this.#materializationSlot === slot && slot.inFlight === inFlight) {
          slot.inFlight = undefined;
        }

        throw error;
      },
    );
  }

  ensureWorkspacePackages(): Promise<WorkspacePackage[]> {
    this.#workspacePackagesPromise ??= this.ensureWorkspaceValidated().then(
      (context) =>
        context.packages.map((workspacePackage) => ({
          ...workspacePackage,
          manifest: { ...workspacePackage.manifest },
        })),
    );
    return this.#workspacePackagesPromise;
  }

  ensureRawWorkspacePackages(): Promise<WorkspacePackage[]> {
    this.#rawWorkspacePackagesPromise ??=
      this.providers.workspace.getRawPackages();
    return this.#rawWorkspacePackagesPromise;
  }

  ensurePackageOwners(): Promise<PackageOwner[]> {
    this.#packageOwnersPromise ??= this.providers.workspace.getPackageOwners();
    return this.#packageOwnersPromise;
  }

  ensureImporters(): Promise<ImporterInfo[]> {
    this.#importersPromise ??= this.providers.workspace.getImporters();
    return this.#importersPromise;
  }

  ensureWorkspaceLookupIndex(): Promise<WorkspaceLookupIndex> {
    this.#workspaceLookupPromise ??= this.providers.workspace.getLookupIndex();
    return this.#workspaceLookupPromise;
  }

  ensureWorkspacePathIndex(): Promise<WorkspaceRegionPathIndex> {
    return this.providers.workspace.getPathIndex();
  }

  ensureWorkspaceDependencyDeclarations(): Promise<
    WorkspaceDependencyDeclaration[]
  > {
    this.#workspaceDependenciesPromise ??=
      this.providers.workspace.getWorkspaceDependencyDeclarations();
    return this.#workspaceDependenciesPromise;
  }

  ensureWorkspaceRegionBoundaries(): Promise<WorkspaceRegionBoundary[]> {
    this.#workspaceRegionBoundariesPromise ??=
      this.providers.workspace.getRegionBoundaries();
    return this.#workspaceRegionBoundariesPromise;
  }

  async ensureSourceGraphProjectExtensions(): Promise<CollectSourceGraphProjectExtensionsResult> {
    this.#sourceGraphProjectExtensionsPromise ??=
      this.#ensureCheckerRouteSnapshot().then((snapshot) =>
        projectSourceGraphProjectExtensions(this.config, snapshot),
      );
    return this.#sourceGraphProjectExtensionsPromise;
  }

  async ensureGraphProjectRoutes(): Promise<CollectCheckerGraphProjectRoutesResult> {
    this.#graphProjectRoutesPromise ??= this.#ensureCheckerRouteSnapshot().then(
      (snapshot) => projectGraphProjectRoutes(this.config, snapshot),
    );
    return this.#graphProjectRoutesPromise;
  }

  async ensureCheckerEntryProjectRoutes(): Promise<CollectCheckerGraphProjectRoutesResult> {
    this.#checkerEntryProjectRoutesPromise ??=
      this.#ensureCheckerRouteSnapshot().then((snapshot) =>
        projectCheckerEntryProjectRoutes(this.config, snapshot),
      );
    return this.#checkerEntryProjectRoutesPromise;
  }

  ensureExpectedSourceFiles(): Promise<Set<string>> {
    this.#expectedSourceFilesPromise ??= Promise.all([
      this.ensureGeneratedGraph(),
      this.ensureWorkspaceValidated(),
    ]).then(([graph, context]) =>
      collectExpectedSourceFiles(this.config, graph, context),
    );
    return this.#expectedSourceFilesPromise;
  }

  async ensurePackageEntrySelectionPlan(
    options: PackageEntryPlanOptions,
  ): Promise<PackageEntrySelectionPlan> {
    const context = await this.ensureWorkspaceValidated();
    return createPackageEntrySelectionPlan({
      config: this.config,
      cwd: options.cwd,
      packageNames: options.packageNames,
      requireCwdPackageMatch: options.requireCwdPackageMatch,
      tool: options.tool,
      workspaceContext: context,
    });
  }

  get importAnalysis(): ImportAnalysisContext {
    return this.providers.imports.context;
  }

  #ensureCheckerRouteSnapshot(): Promise<CheckerRouteSnapshotCollection> {
    this.#checkerRouteSnapshotPromise ??= this.ensureGeneratedGraph().then(
      (graph) =>
        collectCheckerRouteSnapshot(this.config, graph, this.run.metrics),
    );
    return this.#checkerRouteSnapshotPromise;
  }

  #startNextGeneration(): void {
    this.#generation += 1;
    this.#materializationSlot = { generation: this.#generation };
    this.artifactNamespace = createLiminaArtifactNamespace({
      generation: this.#generation,
      rootDir: this.config.rootDir,
    });
    this.providers = createAnalysisProviders(
      this.config,
      this.artifactNamespace,
      this.#profilingMetrics,
    );
    this.run = this.#createRun();
    this.#checkerEntryProjectRoutesPromise = undefined;
    this.#checkerRouteSnapshotPromise = undefined;
    this.#expectedSourceFilesPromise = undefined;
    this.#generatedGraphPromise = undefined;
    this.#graphProjectRoutesPromise = undefined;
    this.#importersPromise = undefined;
    this.#packageOwnersPromise = undefined;
    this.#rawWorkspacePackagesPromise = undefined;
    this.#sourceGraphProjectExtensionsPromise = undefined;
    this.#workspaceDependenciesPromise = undefined;
    this.#workspaceLookupPromise = undefined;
    this.#workspacePackagesPromise = undefined;
    this.#workspaceRegionBoundariesPromise = undefined;
    this.#validatedWorkspaceContextPromise = undefined;
  }

  #createRun(): AnalysisRun {
    return createAnalysisRun({
      generation: identifier<'AnalysisGeneration'>(String(this.#generation)),
      metrics: this.#metrics,
      signal: this.#signal,
      snapshotToken: identifier<'RepositorySnapshotToken'>(
        `${this.config.rootDir}:${this.#generation}`,
      ),
    });
  }
}

export function resolvePreflight(
  config: ResolvedLiminaConfig,
  options: PreflightCapableOptions = {},
): LiminaPreflightManager {
  return (
    options.preflight ??
    new LiminaPreflightManager({
      config,
      generatedGraphProvider: options.generatedGraphProvider,
      providers: options.providers,
    })
  );
}
