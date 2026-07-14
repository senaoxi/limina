import type {
  PackageCheckToolSelection,
  ResolvedLiminaConfig,
} from '#config/runner';
import { type AnalysisProviderSet, createAnalysisProviders } from '#core';
import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
import type { ImportAnalysisContext } from '#core/import-analysis/runner';
import {
  collectCheckerEntryProjectRoutes,
  type CollectCheckerGraphProjectRoutesResult,
  collectGraphProjectRoutes,
  collectSourceGraphProjectExtensions,
  type CollectSourceGraphProjectExtensionsResult,
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
import {
  createWorkspaceLookupIndex,
  type WorkspaceLookupIndex,
} from '../core/workspace/lookup';
import type { WorkspaceRegionBoundary } from '../core/workspace/regions';
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
  readonly config: ResolvedLiminaConfig;
  providers: AnalysisProviderSet;
  run: AnalysisRun;

  readonly #generatedGraphProvider:
    | (() => Promise<GeneratedTsconfigGraphResult>)
    | undefined;
  readonly #metrics: AnalysisMetricsRecorder;
  readonly #signal: AbortSignal;
  #checkerEntryProjectRoutesPromise:
    | Promise<CollectCheckerGraphProjectRoutesResult>
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
  #workspaceRegionBoundariesPromise:
    | Promise<WorkspaceRegionBoundary[]>
    | undefined;
  #materializationSlot: MaterializationSlot = { generation: 0 };

  constructor(options: LiminaPreflightManagerOptions) {
    this.config = options.config;
    this.#generatedGraphProvider = options.generatedGraphProvider;
    this.#metrics = options.metrics ?? createNoopMetricsRecorder();
    this.#signal = options.signal ?? new AbortController().signal;
    this.providers =
      options.providers ?? createAnalysisProviders(options.config);
    this.run = this.#createRun();
    registerPreflightGenerationAdvancer(this, () =>
      this.#startNextGeneration(),
    );
  }

  ensureGeneratedGraph(): Promise<GeneratedTsconfigGraphResult> {
    this.#generatedGraphPromise ??=
      this.#generatedGraphProvider?.() ?? this.providers.buildGraph.getGraph();
    return this.#generatedGraphPromise;
  }

  ensureGeneratedArtifactsMaterialized(): Promise<MaterializationReceipt> {
    const slot = this.#materializationSlot;

    if (slot.receipt) {
      return Promise.resolve(slot.receipt);
    }

    if (slot.inFlight) {
      return slot.inFlight;
    }

    const inFlight = this.ensureGeneratedGraph().then(async (graph) => {
      await materializeGeneratedArtifactPlan(graph.artifactPlan);

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
    this.#workspacePackagesPromise ??= this.providers.workspace.getPackages();
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
    this.#workspaceLookupPromise ??= Promise.all([
      this.ensureImporters(),
      this.ensurePackageOwners(),
      this.ensureWorkspacePackages(),
      this.ensureWorkspaceRegionBoundaries(),
    ]).then(([importers, owners, packages, regionBoundaries]) =>
      createWorkspaceLookupIndex({
        importers,
        owners,
        packages,
        regionBoundaries,
        rootDir: this.config.rootDir,
      }),
    );
    return this.#workspaceLookupPromise;
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
      this.ensureGeneratedGraph().then((graph) =>
        collectSourceGraphProjectExtensions(this.config, graph),
      );
    return this.#sourceGraphProjectExtensionsPromise;
  }

  async ensureGraphProjectRoutes(): Promise<CollectCheckerGraphProjectRoutesResult> {
    this.#graphProjectRoutesPromise ??= this.ensureGeneratedGraph().then(
      (graph) => collectGraphProjectRoutes(this.config, graph),
    );
    return this.#graphProjectRoutesPromise;
  }

  async ensureCheckerEntryProjectRoutes(): Promise<CollectCheckerGraphProjectRoutesResult> {
    this.#checkerEntryProjectRoutesPromise ??= this.ensureGeneratedGraph().then(
      (graph) => collectCheckerEntryProjectRoutes(this.config, graph),
    );
    return this.#checkerEntryProjectRoutesPromise;
  }

  ensureExpectedSourceFiles(): Promise<Set<string>> {
    this.#expectedSourceFilesPromise ??= Promise.all([
      this.ensureGeneratedGraph(),
      this.ensureWorkspacePackages(),
      this.ensureWorkspaceRegionBoundaries(),
    ]).then(([graph, packages, boundaries]) =>
      collectExpectedSourceFiles(this.config, graph, packages, boundaries),
    );
    return this.#expectedSourceFilesPromise;
  }

  ensurePackageEntrySelectionPlan(
    options: PackageEntryPlanOptions,
  ): Promise<PackageEntrySelectionPlan> {
    return Promise.resolve(
      createPackageEntrySelectionPlan({
        config: this.config,
        cwd: options.cwd,
        packageNames: options.packageNames,
        requireCwdPackageMatch: options.requireCwdPackageMatch,
        tool: options.tool,
      }),
    );
  }

  get importAnalysis(): ImportAnalysisContext {
    return this.providers.imports.context;
  }

  #startNextGeneration(): void {
    this.#generation += 1;
    this.#materializationSlot = { generation: this.#generation };
    this.providers = createAnalysisProviders(this.config);
    this.run = this.#createRun();
    this.#checkerEntryProjectRoutesPromise = undefined;
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
