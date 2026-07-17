import {
  createExplicitMutationAuthority,
  type MutationBoundarySnapshot,
  type MutationBoundaryTarget,
  preflightMutationBoundary,
  recheckMutationBoundary,
} from '#utils/mutation-boundary';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import {
  collectVueTsgoConfigPaths,
  createVueTsgoCachePaths,
  findNearestPackageDir,
  isVueTsgoCommand,
  type TypecheckTarget,
} from './targets';

export class VueTsgoCacheBoundaryError extends Error {
  override readonly name = 'VueTsgoCacheBoundaryError';
}

export class VueTsgoCacheBatchCoordinator {
  readonly #snapshotsByCheckerTargetId: ReadonlyMap<
    TypecheckTarget['id'],
    MutationBoundarySnapshot
  >;

  private constructor(
    snapshotsByCheckerTargetId: ReadonlyMap<
      TypecheckTarget['id'],
      MutationBoundarySnapshot
    >,
  ) {
    this.#snapshotsByCheckerTargetId = snapshotsByCheckerTargetId;
  }

  /**
   * Performs the one permitted cache cleanup for an execution batch. Every
   * route is authenticated and recursively scanned before the first rm().
   */
  static async prepare(
    targets: readonly TypecheckTarget[],
    options: { requireValidGeneratedRoute?: boolean } = {},
  ): Promise<VueTsgoCacheBatchCoordinator> {
    const generation = randomUUID();
    const boundaryTargetsByPath = new Map<string, MutationBoundaryTarget>();
    const cachePathsByTargetId = new Map<TypecheckTarget['id'], Set<string>>();

    for (const target of targets) {
      if (!isVueTsgoCommand(target.command)) continue;
      const targetCachePaths = cachePathsByTargetId.get(target.id) ?? new Set();
      for (const configPath of collectVueTsgoConfigPaths(target, {
        requireValidGeneratedRoute: options.requireValidGeneratedRoute ?? true,
      })) {
        const packageDir = findNearestPackageDir(configPath);
        if (!packageDir) {
          throw new VueTsgoCacheBoundaryError(
            `Unable to authenticate vue-tsgo cache package root for ${configPath}.`,
          );
        }
        for (const cachePath of createVueTsgoCachePaths(configPath)) {
          targetCachePaths.add(cachePath);
          if (boundaryTargetsByPath.has(cachePath)) continue;
          const authority = await createExplicitMutationAuthority({
            generation,
            logicalMutationRoot: cachePath,
            scope: 'directory',
            trustedBasePath: packageDir,
          });
          boundaryTargetsByPath.set(cachePath, {
            authority,
            kind: 'directory',
            path: cachePath,
            recursive: true,
          });
        }
      }
      cachePathsByTargetId.set(target.id, targetCachePaths);
    }

    const allBoundaryTargets = [...boundaryTargetsByPath.values()];
    await preflightMutationBoundary(allBoundaryTargets);
    const deletionSnapshots = new Map<string, MutationBoundarySnapshot>();
    for (const boundaryTarget of allBoundaryTargets) {
      deletionSnapshots.set(
        boundaryTarget.path,
        await preflightMutationBoundary([boundaryTarget]),
      );
    }

    // All targets have passed the batch scan. Each path still receives an
    // immediate recheck before its recursive mutation.
    for (const boundaryTarget of allBoundaryTargets) {
      await recheckMutationBoundary(
        deletionSnapshots.get(boundaryTarget.path)!,
      );
      await rm(boundaryTarget.path, {
        force: true,
        maxRetries: 3,
        recursive: true,
        retryDelay: 50,
      });
    }

    const snapshotsByCheckerTargetId = new Map<
      TypecheckTarget['id'],
      MutationBoundarySnapshot
    >();
    for (const [targetId, cachePaths] of cachePathsByTargetId) {
      snapshotsByCheckerTargetId.set(
        targetId,
        await preflightMutationBoundary(
          [...cachePaths]
            .map((cachePath) => boundaryTargetsByPath.get(cachePath)!)
            .sort((left, right) => left.path.localeCompare(right.path)),
        ),
      );
    }

    return new VueTsgoCacheBatchCoordinator(snapshotsByCheckerTargetId);
  }

  async beforeTargetRun(target: TypecheckTarget): Promise<void> {
    const snapshot = this.#snapshotsByCheckerTargetId.get(target.id);
    if (!snapshot) return;
    await recheckMutationBoundary(snapshot);
  }
}
