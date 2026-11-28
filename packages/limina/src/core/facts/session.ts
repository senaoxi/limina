import type { GovernedSourceUnit } from '../build-graph/types';
import type {
  ProjectDependencyCaches,
  ProjectDependencyCollection,
  ProjectDependencyRequest,
} from '../project-dependencies/contracts';
import { createProjectSemanticCacheIdentity } from '../project-dependencies/identity';
import { collectProjectDependencies } from '../project-dependencies/provider';
import { collectRuntimeProjectDependencies } from '../project-dependencies/runtime-source';
import type { WorkspaceSourceBoundary } from '../typescript-semantic';
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
  getRuntimeProjectDependencies(
    unit: GovernedSourceUnit,
  ): ProjectDependencyCollection;
  getWorkspaceSourceBoundary(): WorkspaceSourceBoundary;
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
  readonly #governedRuntime = new Map<
    GovernedSourceUnit,
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

  getLockedWorkspaceSourceBoundary(): WorkspaceSourceBoundary {
    return (
      this.#projectDependencies.lockedWorkspaceSourceBoundary ??
      this.getWorkspaceSourceBoundary()
    );
  }

  publishWorkspaceSourceBoundary(boundary: WorkspaceSourceBoundary): void {
    this.#workspaceSourceBoundary = boundary;
  }

  hasWorkspaceSourceBoundary(): boolean {
    return this.#workspaceSourceBoundary !== undefined;
  }

  requireProduct(product: FactProduct): void {
    if (
      this.#subscriptionPlan !== undefined &&
      !this.#subscriptionPlan.products.includes(product)
    ) {
      throw new CoreSubscriptionViolationError(
        product,
        this.#subscriptionPlan.capabilities,
      );
    }
  }

  getGovernedRuntime(
    unit: GovernedSourceUnit,
  ): ProjectDependencyCollection | undefined {
    this.requireProduct('runtime-only');
    return this.#governedRuntime.get(unit);
  }

  publishGovernedRuntime(
    unit: GovernedSourceUnit,
    collection: ProjectDependencyCollection,
  ): ProjectDependencyCollection {
    this.#governedRuntime.set(unit, collection);
    return collection;
  }

  prepareRuntimeProjectDependencies(
    request: Omit<ProjectDependencyRequest, 'caches' | 'managedOutputLookup'>,
  ): ProjectDependencyCollection {
    this.requireProduct('runtime-only');
    const fullRequest = {
      ...request,
      caches: this.#projectDependencies,
    };
    const workId = JSON.stringify([
      createProjectSemanticCacheIdentity(request.context),
      request.runtimeFileNames,
    ]);
    const cached = this.#runtimeDependenciesByWorkId.get(workId);
    if (cached !== undefined) {
      this.#runtimeCollectionReuses += 1;
      return cached;
    }
    const collection = collectRuntimeProjectDependencies(fullRequest);
    this.#runtimeDependenciesByWorkId.set(workId, collection);
    return collection;
  }

  prepareSemanticProjectDependencies(
    request: Omit<ProjectDependencyRequest, 'caches'>,
  ): ProjectDependencyCollection {
    this.requireProduct('native');
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
      getRuntimeProjectDependencies: (
        unit: GovernedSourceUnit,
      ): ProjectDependencyCollection => {
        requireProduct('runtime-only');
        const collection = this.getGovernedRuntime(unit);
        if (collection === undefined)
          throw new Error(
            `Runtime facts have not been prepared for ${unit.configPath}.`,
          );
        return collection;
      },
      getWorkspaceSourceBoundary: (): WorkspaceSourceBoundary => {
        requireProduct('membership');
        return this.getWorkspaceSourceBoundary();
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
    this.#governedRuntime.clear();
    this.#runtimeDependenciesByWorkId.clear();
  }
}
