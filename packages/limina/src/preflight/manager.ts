import type {
  PackageCheckToolSelection,
  ResolvedLiminaConfig,
} from '#config/runner';
import { createLiminaCore, type LiminaCore } from '#core';
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
import type { WorkspaceDependencyDeclaration } from '../core/packages/authority';
import {
  createWorkspaceLookupIndex,
  type WorkspaceLookupIndex,
} from '../core/workspace/lookup';
import {
  createPackageEntrySelectionPlan,
  type PackageEntrySelectionPlan,
} from '../package-check/entry-selection';
import { collectExpectedSourceFiles } from '../proof/source-files';

export interface LiminaPreflightManagerOptions {
  config: ResolvedLiminaConfig;
  core?: LiminaCore;
  generatedGraphProvider?: () => Promise<GeneratedTsconfigGraphResult>;
}

export interface PackageEntryPlanOptions {
  cwd: string;
  packageNames?: readonly string[];
  requireCwdPackageMatch: boolean;
  tool?: PackageCheckToolSelection;
}

export interface PreflightCapableOptions {
  core?: LiminaCore;
  generatedGraphProvider?: () => Promise<GeneratedTsconfigGraphResult>;
  preflight?: LiminaPreflightManager;
}

export class LiminaPreflightManager {
  readonly config: ResolvedLiminaConfig;
  readonly core: LiminaCore;

  readonly #generatedGraphProvider:
    | (() => Promise<GeneratedTsconfigGraphResult>)
    | undefined;

  readonly #cache = new Map<string, Promise<unknown>>();

  constructor(options: LiminaPreflightManagerOptions) {
    this.config = options.config;
    this.core = options.core ?? createLiminaCore(options.config);
    this.#generatedGraphProvider = options.generatedGraphProvider;
  }

  #ensure<T>(key: string, factory: () => Promise<T>): Promise<T> {
    const cached = this.#cache.get(key);

    if (cached) {
      return cached as Promise<T>;
    }

    const promise = factory();

    this.#cache.set(key, promise);

    return promise;
  }

  ensureGeneratedGraph(): Promise<GeneratedTsconfigGraphResult> {
    return this.#ensure('generatedGraph', () =>
      this.#generatedGraphProvider
        ? this.#generatedGraphProvider()
        : this.core.buildGraph.getGraph(),
    );
  }

  ensureWorkspacePackages(): Promise<WorkspacePackage[]> {
    return this.#ensure('workspacePackages', () =>
      this.core.workspace.getPackages(),
    );
  }

  ensurePackageOwners(): Promise<PackageOwner[]> {
    return this.#ensure('packageOwners', () =>
      this.core.workspace.getPackageOwners(),
    );
  }

  ensureImporters(): Promise<ImporterInfo[]> {
    return this.#ensure('importers', () => this.core.workspace.getImporters());
  }

  ensureWorkspaceLookupIndex(): Promise<WorkspaceLookupIndex> {
    return this.#ensure('workspaceLookupIndex', async () =>
      createWorkspaceLookupIndex({
        importers: await this.ensureImporters(),
        owners: await this.ensurePackageOwners(),
        packages: await this.ensureWorkspacePackages(),
        rootDir: this.config.rootDir,
      }),
    );
  }

  ensureWorkspaceDependencyDeclarations(): Promise<
    WorkspaceDependencyDeclaration[]
  > {
    return this.#ensure('workspaceDependencyDeclarations', () =>
      this.core.workspace.getWorkspaceDependencyDeclarations(),
    );
  }

  async ensureSourceGraphProjectExtensions(): Promise<CollectSourceGraphProjectExtensionsResult> {
    return this.#ensure('sourceGraphProjectExtensions', async () =>
      collectSourceGraphProjectExtensions(
        this.config,
        await this.ensureGeneratedGraph(),
      ),
    );
  }

  async ensureGraphProjectRoutes(): Promise<CollectCheckerGraphProjectRoutesResult> {
    return this.#ensure('graphProjectRoutes', async () =>
      collectGraphProjectRoutes(this.config, await this.ensureGeneratedGraph()),
    );
  }

  async ensureCheckerEntryProjectRoutes(): Promise<CollectCheckerGraphProjectRoutesResult> {
    return this.#ensure('checkerEntryProjectRoutes', async () =>
      collectCheckerEntryProjectRoutes(
        this.config,
        await this.ensureGeneratedGraph(),
      ),
    );
  }

  ensureExpectedSourceFiles(): Promise<Set<string>> {
    return this.#ensure('expectedSourceFiles', async () =>
      collectExpectedSourceFiles(
        this.config,
        await this.ensureGeneratedGraph(),
      ),
    );
  }

  ensurePackageEntrySelectionPlan(
    options: PackageEntryPlanOptions,
  ): Promise<PackageEntrySelectionPlan> {
    return this.#ensure(createPackageEntrySelectionPlanCacheKey(options), () =>
      Promise.resolve(
        createPackageEntrySelectionPlan({
          config: this.config,
          cwd: options.cwd,
          packageNames: options.packageNames,
          requireCwdPackageMatch: options.requireCwdPackageMatch,
          tool: options.tool,
        }),
      ),
    );
  }

  get importAnalysis(): ImportAnalysisContext {
    return this.core.imports.context;
  }

  invalidateAll(): void {
    this.#cache.clear();
    this.core.invalidateAll();
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
      core: options.core,
      generatedGraphProvider: options.generatedGraphProvider,
    })
  );
}

function createPackageEntrySelectionPlanCacheKey(
  options: PackageEntryPlanOptions,
): string {
  return `packageEntrySelectionPlan:${JSON.stringify({
    cwd: options.cwd,
    packageNames: [...(options.packageNames ?? [])],
    requireCwdPackageMatch: options.requireCwdPackageMatch,
    tool: options.tool ?? null,
  })}`;
}
