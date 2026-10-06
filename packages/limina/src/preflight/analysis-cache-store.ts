import { lstatSync, readFileSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import path from 'pathe';
import type { AnalysisMetricsRecorder } from '../application/analysis/analysis-run';
import { writeJsonAtomically } from '../check-reporting/atomic-writer';
import type { AnalysisSnapshot } from '../core/analysis-cache/contracts';
import { analysisHash } from '../core/analysis-cache/identity';
import type { NativeAnalysisCache } from '../core/analysis-cache/native-cache';
import { parseAnalysisSnapshot } from '../core/analysis-cache/snapshot-schema';
import {
  assertArtifactPathLexicallyContained,
  assertArtifactPathOperationSafe,
  type LiminaArtifactNamespace,
  resolveArtifactNamespacePath,
} from '../domain/artifacts/namespace';
import {
  assertArtifactPathStatsSafe,
  getRelativeSegments,
} from '../domain/artifacts/namespace-safety-shared';
import { acquireCrossProcessWriteLease } from '../utils/mutation/cross-process-lease';

interface CacheStoreOptions {
  namespace: LiminaArtifactNamespace;
  identity: string;
  configPath: string;
  metrics?: AnalysisMetricsRecorder;
}

export class AnalysisCacheStore {
  readonly #options: CacheStoreOptions;
  #revision: string | undefined;
  readonly path: string;
  readonly identity: string;
  constructor(options: CacheStoreOptions) {
    this.#options = options;
    this.identity = options.identity;
    this.path = resolveArtifactNamespacePath(
      options.namespace,
      'cache',
      'analysis-v1',
      analysisHash(options.configPath),
      'snapshot.json',
    );
  }

  #read(): AnalysisSnapshot | undefined {
    try {
      this.#assertReadSafe();
      return parseAnalysisSnapshot(
        JSON.parse(readFileSync(this.path, 'utf8')),
        this.identity,
      );
    } catch (error) {
      String(error);
      return undefined;
    }
  }

  #assertReadSafe(): void {
    const namespace = this.#options.namespace;
    assertArtifactPathLexicallyContained(namespace, this.path);
    let cursor = namespace.rootDir;
    for (const segment of ['', ...getRelativeSegments(namespace, this.path)]) {
      cursor = path.join(cursor, segment);
      const role = cursor === this.path ? 'target-file' : 'parent-directory';
      assertArtifactPathStatsSafe(cursor, lstatSync(cursor), new Set([role]));
    }
  }

  #isBaselineCurrent(): boolean {
    return this.#read()?.header.revision === this.#revision;
  }

  #record(measurement: Parameters<AnalysisMetricsRecorder['record']>[0]): void {
    this.#options.metrics?.record(measurement);
  }

  async #write(
    snapshot: AnalysisSnapshot,
    assertCurrent: () => void | Promise<void>,
  ): Promise<void> {
    const start = performance.now();
    try {
      await writeJsonAtomically(this.#options.namespace, this.path, snapshot, {
        rename: async (from, to) => {
          await assertCurrent();
          if (!this.#isBaselineCurrent())
            throw new Error(
              'Analysis snapshot revision changed before publication.',
            );
          await rename(from, to);
        },
      });
      this.#revision = snapshot.header.revision;
      this.#record({
        name: 'analysis-cache',
        kind: 'write',
        durationMs: performance.now() - start,
        estimatedBytes: Buffer.byteLength(JSON.stringify(snapshot)),
      });
    } catch (error) {
      // Only storage I/O is best effort; drift and authorization failures stop
      // publication and must not be converted into a successful check.
      if (!isStorageError(error)) throw error;
      this.#record({
        name: 'analysis-cache',
        kind: 'write-failure',
        count: 1,
      });
    }
  }

  read(): AnalysisSnapshot | undefined {
    const start = performance.now();
    const snapshot = this.#read();
    this.#revision = snapshot?.header.revision;
    this.#record({
      name: 'analysis-cache',
      kind: 'read',
      durationMs: performance.now() - start,
    });
    return snapshot;
  }

  async publish(
    cache: NativeAnalysisCache,
    assertCurrent: () => void | Promise<void> = () =>
      cache.inputs.assertStable(),
  ): Promise<void> {
    const { namespace, configPath } = this.#options;
    await assertArtifactPathOperationSafe(namespace, this.path);
    const lease = await acquireCrossProcessWriteLease(
      namespace.canonicalRootDir,
      { leaseName: `analysis-${analysisHash(configPath)}` },
    );
    try {
      await assertCurrent();
      cache.inputs.assertStable();
      if (!this.#isBaselineCurrent()) return;
      await this.#write(cache.snapshot(), async () => {
        await assertCurrent();
        cache.inputs.assertStable();
      });
    } finally {
      await lease.release();
    }
  }
}

function isStorageError(error: unknown): boolean {
  return error instanceof Error && 'code' in error;
}
