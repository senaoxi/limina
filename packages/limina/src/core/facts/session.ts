import { compareCodeUnits } from '#utils/collections';
import { normalizeAbsolutePath } from '#utils/path';
import { analysisHash } from '../analysis-cache/identity';
import { managedOutputLookupIdentity } from '../import-graph/managed-output-provider';
import type {
  ProjectDependencyCaches,
  ProjectDependencyCollection,
  ProjectDependencyRequest,
} from '../project-dependencies/contracts';
import { collectProjectDependencies } from '../project-dependencies/provider';
import { collectRuntimeProjectDependencies } from '../project-dependencies/runtime-source';
import type { WorkspaceSourceBoundary } from '../typescript-semantic';
import { effectiveCompilerOptions } from '../typescript-semantic/compiler-options';
import type { FactProduct, SubscriptionPlan } from './subscription';

export class CoreSubscriptionViolationError extends Error {
  override readonly name = 'CoreSubscriptionViolationError';
  readonly product: FactProduct;
  readonly capabilities: readonly string[];

  constructor(product: FactProduct, capabilities: readonly string[]) {
    super(
      `Core fact product "${product}" is not subscribed by [${capabilities.join(', ')}].`,
    );
    this.product = product;
    this.capabilities = capabilities;
  }
}

export interface SubscribedCoreFactView {
  readonly plan: SubscriptionPlan;
  getWorkspaceSourceBoundary(): WorkspaceSourceBoundary;
  getRuntimeProjectDependencies(
    request: Omit<ProjectDependencyRequest, 'caches'>,
  ): ProjectDependencyCollection;
  getSemanticProjectDependencies(
    request: Omit<ProjectDependencyRequest, 'caches'>,
  ): ProjectDependencyCollection;
}

function runtimeWorkIdentity(request: ProjectDependencyRequest): string {
  const { context } = request;
  const virtuals =
    context.virtualFiles === undefined || context.virtualFiles.size === 0
      ? null
      : analysisHash(Array.from(context.virtualFiles));
  const sortedFiles = [...context.fileNames]
    .map((fileName) => normalizeAbsolutePath(fileName))
    .sort(compareCodeUnits);
  // Plain TypeScript runtime collections never consult managedOutputLookup;
  // omitting it lets graph:check and source:check reuse the same runtime facts.
  const managedOutput =
    context.semanticAuthority.family === 'typescript'
      ? null
      : (managedOutputLookupIdentity(request.managedOutputLookup) ?? null);
  return JSON.stringify([
    normalizeAbsolutePath(context.configPath),
    context.generation,
    sortedFiles,
    analysisHash(effectiveCompilerOptions(context.compilerOptions)),
    context.semanticAuthority.family,
    managedOutput,
    virtuals,
  ]);
}

/**
 * Provider-generation-scoped Core fact session.
 * Owns Stage A/B1 WorkspaceSourceBoundary publication, WorkIdentity-deduplicated
 * runtime & semantic dependency fact production, and subscription-enforced views.
 */
export class CoreFactSession {
  #workspaceSourceBoundary: WorkspaceSourceBoundary | undefined;
  readonly #projectDependencies: ProjectDependencyCaches;
  readonly #subscriptionPlan: SubscriptionPlan | undefined;
  readonly #runtimeDependenciesByWorkId = new Map<
    string,
    ProjectDependencyCollection
  >();
  #runtimeCollectionReuses = 0;

  getWorkspaceSourceBoundary = (): WorkspaceSourceBoundary => {
    if (this.#workspaceSourceBoundary !== undefined) {
      return this.#workspaceSourceBoundary;
    }
    throw new Error(
      'Workspace source boundary is unavailable before Stage A source membership preparation.',
    );
  };

  constructor(
    projectDependencies: ProjectDependencyCaches,
    subscriptionPlan?: SubscriptionPlan,
  ) {
    this.#projectDependencies = projectDependencies;
    this.#subscriptionPlan = subscriptionPlan;
  }

  getSubscriptionPlan(): SubscriptionPlan | undefined {
    return this.#subscriptionPlan;
  }

  publishWorkspaceSourceBoundary(boundary: WorkspaceSourceBoundary): void {
    this.#workspaceSourceBoundary = boundary;
  }

  hasWorkspaceSourceBoundary(): boolean {
    return this.#workspaceSourceBoundary !== undefined;
  }

  getRuntimeProjectDependencies(
    request: Omit<ProjectDependencyRequest, 'caches'>,
  ): ProjectDependencyCollection {
    if (
      this.#subscriptionPlan !== undefined &&
      !this.#subscriptionPlan.products.includes('runtime-only')
    ) {
      throw new CoreSubscriptionViolationError(
        'runtime-only',
        this.#subscriptionPlan.capabilities,
      );
    }
    const fullRequest: ProjectDependencyRequest = {
      ...request,
      caches: this.#projectDependencies,
    };
    const workId = runtimeWorkIdentity(fullRequest);
    const cached = this.#runtimeDependenciesByWorkId.get(workId);
    if (cached !== undefined) {
      this.#runtimeCollectionReuses += 1;
      return cached;
    }
    const collection = collectRuntimeProjectDependencies(fullRequest);
    this.#runtimeDependenciesByWorkId.set(workId, collection);
    return collection;
  }

  getSemanticProjectDependencies(
    request: Omit<ProjectDependencyRequest, 'caches'>,
  ): ProjectDependencyCollection {
    return collectProjectDependencies({
      ...request,
      caches: this.#projectDependencies,
    });
  }

  createSubscribedView(plan: SubscriptionPlan): SubscribedCoreFactView {
    const allowed = new Set<FactProduct>(plan.products);
    const requireProduct = (product: FactProduct): void => {
      if (!allowed.has(product)) {
        throw new CoreSubscriptionViolationError(product, plan.capabilities);
      }
    };
    return Object.freeze({
      plan,
      getWorkspaceSourceBoundary: (): WorkspaceSourceBoundary => {
        requireProduct('membership');
        return this.getWorkspaceSourceBoundary();
      },
      getRuntimeProjectDependencies: (
        request: Omit<ProjectDependencyRequest, 'caches'>,
      ): ProjectDependencyCollection => {
        requireProduct('runtime-only');
        return this.getRuntimeProjectDependencies(request);
      },
      getSemanticProjectDependencies: (
        request: Omit<ProjectDependencyRequest, 'caches'>,
      ): ProjectDependencyCollection => {
        requireProduct('native');
        return this.getSemanticProjectDependencies(request);
      },
    });
  }

  getFactCounters(): Readonly<{
    nativeResolutionReuses: number;
    runtimeCollectionReuses: number;
    runtimeOnlyResolutions: number;
  }> {
    return {
      nativeResolutionReuses:
        this.#projectDependencies.factCounters?.nativeResolutionReuses ?? 0,
      runtimeCollectionReuses: this.#runtimeCollectionReuses,
      runtimeOnlyResolutions:
        this.#projectDependencies.factCounters?.runtimeOnlyResolutions ?? 0,
    };
  }

  dispose(): void {
    this.#runtimeDependenciesByWorkId.clear();
  }
}
