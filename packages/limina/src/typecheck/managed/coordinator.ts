import {
  type MutationBoundarySnapshot,
  preflightMutationBoundary,
  recheckMutationBoundary,
} from '#utils/mutation-boundary';
import { toRelativePath } from '#utils/path';
import type { TypecheckTarget } from '../targets';
import { invalidateStaleBuildInfo } from './build-info';
import { proveManagedCheckerMutationContext } from './proof';
import {
  ManagedCheckerEmitBoundaryError,
  type ManagedMutationCoordinatorOptions,
  type ProvenManagedCheckerMutationContext,
} from './types';

async function collectInitialProofs(
  options: ManagedMutationCoordinatorOptions,
): Promise<Map<TypecheckTarget['id'], ProvenManagedCheckerMutationContext>> {
  const proofs = new Map<
    TypecheckTarget['id'],
    ProvenManagedCheckerMutationContext
  >();
  for (const target of options.targets) {
    proofs.set(
      target.id,
      await proveManagedCheckerMutationContext({
        artifactNamespace: options.artifactNamespace,
        checkers: options.checkers,
        generatedGraph: options.generatedGraph,
        projectRootDir: options.config.rootDir,
        target,
        workspaceContext: options.workspaceContext,
      }),
    );
  }
  return proofs;
}

function getAllMutationTargets(
  proofs: ReadonlyMap<unknown, ProvenManagedCheckerMutationContext>,
) {
  return [...proofs.values()].flatMap((proof) => proof.mutationTargets);
}

function assertMatchingProof(options: {
  current: ProvenManagedCheckerMutationContext;
  expected: ProvenManagedCheckerMutationContext | undefined;
  message: string;
}): void {
  if (options.expected !== undefined) {
    if (options.current.fingerprint === options.expected.fingerprint) return;
  }
  throw new ManagedCheckerEmitBoundaryError(options.message);
}

export class ManagedCheckerMutationCoordinator {
  readonly #initialProofs: ReadonlyMap<
    TypecheckTarget['id'],
    ProvenManagedCheckerMutationContext
  >;
  readonly #layerProofs = new Map<
    TypecheckTarget['id'],
    ProvenManagedCheckerMutationContext
  >();
  readonly #layerSnapshots = new Map<
    TypecheckTarget['id'],
    MutationBoundarySnapshot
  >();
  readonly #options: ManagedMutationCoordinatorOptions;

  private constructor(
    options: ManagedMutationCoordinatorOptions,
    initialProofs: ReadonlyMap<
      TypecheckTarget['id'],
      ProvenManagedCheckerMutationContext
    >,
  ) {
    this.#options = options;
    this.#initialProofs = initialProofs;
  }

  static async create(
    options: ManagedMutationCoordinatorOptions,
  ): Promise<ManagedCheckerMutationCoordinator> {
    const initialProofs = await collectInitialProofs(options);
    await preflightMutationBoundary(getAllMutationTargets(initialProofs));
    return new ManagedCheckerMutationCoordinator(options, initialProofs);
  }

  async beforeLayerRun(targets: readonly TypecheckTarget[]): Promise<void> {
    const layerProofs: ProvenManagedCheckerMutationContext[] = [];
    for (const target of targets) {
      const current = await this.#prove(target);
      assertMatchingProof({
        current,
        expected: this.#initialProofs.get(target.id),
        message: `Managed checker emit proof drifted before provider layer: ${toRelativePath(this.#options.config.rootDir, target.configPath)}.`,
      });
      this.#layerProofs.set(target.id, current);
      layerProofs.push(current);
    }
    await preflightMutationBoundary(
      layerProofs.flatMap((proof) => proof.mutationTargets),
    );
    await invalidateStaleBuildInfo(layerProofs);
    await this.#captureLayerSnapshots(layerProofs);
  }

  async beforeTargetRun(target: TypecheckTarget): Promise<void> {
    const current = await this.#prove(target);
    const expected =
      this.#layerProofs.get(target.id) ?? this.#initialProofs.get(target.id);
    assertMatchingProof({
      current,
      expected,
      message: `Managed checker emit proof drifted immediately before runner: ${toRelativePath(this.#options.config.rootDir, target.configPath)}.`,
    });
    const layerSnapshot = this.#layerSnapshots.get(target.id);
    if (layerSnapshot === undefined) {
      throw new ManagedCheckerEmitBoundaryError(
        `Managed checker target has no provider-layer boundary snapshot: ${toRelativePath(this.#options.config.rootDir, target.configPath)}.`,
      );
    }
    await recheckMutationBoundary(layerSnapshot);
  }

  async #captureLayerSnapshots(
    proofs: readonly ProvenManagedCheckerMutationContext[],
  ): Promise<void> {
    for (const proof of proofs) {
      this.#layerSnapshots.set(
        proof.targetId,
        await preflightMutationBoundary(proof.mutationTargets),
      );
    }
  }

  async #prove(
    target: TypecheckTarget,
  ): Promise<ProvenManagedCheckerMutationContext> {
    return proveManagedCheckerMutationContext({
      artifactNamespace: this.#options.artifactNamespace,
      checkers: this.#options.checkers,
      generatedGraph: this.#options.generatedGraph,
      projectRootDir: this.#options.config.rootDir,
      target,
      workspaceContext: this.#options.workspaceContext,
    });
  }
}
