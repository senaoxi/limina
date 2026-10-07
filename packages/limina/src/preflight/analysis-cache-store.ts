import { createHash } from 'node:crypto';
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
  configVersion?: string;
  metrics?: AnalysisMetricsRecorder;
}

export class AnalysisCacheStore {
  readonly #options: CacheStoreOptions;
  #hasBaseline = true;
  #storedRevision: string | undefined;
  #baseline: string | undefined;
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

  #readBytes(): Buffer | undefined {
    try {
      this.#assertReadSafe();
      return readFileSync(this.path);
    } catch (error) {
      if (!isAbsent(error)) this.#hasBaseline = false;
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
    const bytes = this.#readBytes();
    return this.#hasBaseline && physicalRevision(bytes) === this.#baseline;
  }

  #record(measurement: Parameters<AnalysisMetricsRecorder['record']>[0]): void {
    this.#options.metrics?.record(measurement);
  }

  async #write(
    snapshot: AnalysisSnapshot,
    assertCurrent: () => void | Promise<void>,
  ): Promise<void> {
    const start = performance.now();
    let encoded = '';
    try {
      await writeJsonAtomically(this.#options.namespace, this.path, snapshot, {
        serialize: (value) => {
          encoded = JSON.stringify(value);
          return encoded;
        },
        rename: async (from, to) => {
          await assertPublicationCurrent(assertCurrent);
          if (!this.#isBaselineCurrent())
            throw new Error(
              'Analysis snapshot revision changed before publication.',
            );
          await rename(from, to);
        },
      });
      this.#baseline = physicalRevision(Buffer.from(`${encoded}\n`));
      this.#storedRevision = snapshot.header.revision;
      this.#record({
        name: 'analysis-cache',
        kind: 'write',
        durationMs: performance.now() - start,
        estimatedBytes: Buffer.byteLength(encoded) + 1,
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

  async #publishChanged(
    cache: NativeAnalysisCache,
    assertCurrent: () => void | Promise<void>,
  ): Promise<void> {
    if (!this.#hasBaseline) return;
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
  #isStoredModelUnchanged(cache: NativeAnalysisCache): boolean {
    return [
      this.#storedRevision !== undefined,
      cache.previous?.header.revision === this.#storedRevision,
      cache.isUnchanged(),
    ].every(Boolean);
  }
  #decodeSnapshot(bytes: Buffer | undefined): AnalysisSnapshot | undefined {
    const version = this.#options.configVersion;
    return version === undefined
      ? undefined
      : decodeSnapshot(bytes, this.identity, version);
  }
  #canPublish(cache: NativeAnalysisCache): boolean {
    return [
      this.#options.configVersion !== undefined,
      cache.configVersion === this.#options.configVersion,
    ].every(Boolean);
  }
  async #publishQualified(
    cache: NativeAnalysisCache,
    assertCurrent: () => void | Promise<void>,
  ): Promise<void> {
    if (this.#isStoredModelUnchanged(cache)) {
      await assertCurrent();
      cache.inputs.assertStable();
      this.#record({ name: 'analysis-cache', kind: 'unchanged', count: 1 });
      return;
    }
    await this.#publishChanged(cache, assertCurrent);
  }
  read(): AnalysisSnapshot | undefined {
    const start = performance.now();
    this.#hasBaseline = true;
    const bytes = this.#readBytes();
    this.#baseline = physicalRevision(bytes);
    const snapshot = this.#decodeSnapshot(bytes);
    this.#storedRevision = snapshot?.header.revision;
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
    if (!this.#canPublish(cache)) return;
    await this.#publishQualified(cache, assertCurrent);
  }
}

async function assertPublicationCurrent(
  assertCurrent: () => void | Promise<void>,
): Promise<void> {
  try {
    await assertCurrent();
  } catch (error) {
    // Filesystem errors from observed-input validation are not cache-storage
    // failures. Publication must preserve their stop contract.
    throw new Error(error instanceof Error ? error.message : String(error), {
      cause: error,
    });
  }
}

function physicalRevision(bytes: Buffer | undefined): string | undefined {
  return bytes === undefined
    ? undefined
    : createHash('sha256').update(bytes).digest('hex');
}
function decodeSnapshot(
  bytes: Buffer | undefined,
  identity: string,
  configVersion: string,
): AnalysisSnapshot | undefined {
  if (bytes === undefined) return undefined;
  try {
    return parseAnalysisSnapshot(
      JSON.parse(bytes.toString('utf8')),
      identity,
      configVersion,
    );
  } catch {
    return undefined;
  }
}

function isStorageError(error: unknown): boolean {
  return error instanceof Error && 'code' in error;
}

function isAbsent(error: unknown): boolean {
  return ['ENOENT', 'ENOTDIR'].includes(
    String((error as NodeJS.ErrnoException).code),
  );
}
