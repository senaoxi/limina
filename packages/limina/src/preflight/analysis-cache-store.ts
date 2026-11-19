import { createHash } from 'node:crypto';
import { rename } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import path from 'pathe';
import type { AnalysisMetricsRecorder } from '../application/analysis/analysis-run';
import { writeJsonAtomically } from '../check-reporting/atomic-writer';
import {
  AnalysisInputDriftError,
  type AnalysisSnapshot,
} from '../core/analysis-cache/contracts';
import { analysisHash } from '../core/analysis-cache/identity';
import { InstallationLockGate } from '../core/analysis-cache/installation-gate';
import type { NativeAnalysisCache } from '../core/analysis-cache/native-cache';
import { cloneAnalysisSnapshot } from '../core/analysis-cache/snapshot-receipts';
import { snapshotModel } from '../core/analysis-cache/snapshot-records';
import {
  assertArtifactPathOperationSafe,
  type LiminaArtifactNamespace,
  resolveArtifactNamespacePath,
} from '../domain/artifacts/namespace';
import { acquireCrossProcessWriteLease } from '../utils/mutation/cross-process-lease';
import {
  AnalysisCacheBlocks,
  readAnalysisCacheFile,
} from './analysis-cache-blocks';
import { AnalysisSnapshotDecoder } from './analysis-cache-decode';
import type { ConfigObservation } from './config-observation';

interface CacheStoreOptions {
  governanceRoot?: string;
  namespace: LiminaArtifactNamespace;
  identity: string;
  configPath: string;
  configVersion?: string;
  metrics?: AnalysisMetricsRecorder;
  configuration?: ConfigObservation;
}

export class AnalysisCacheStore {
  readonly #options: CacheStoreOptions;
  #hasBaseline = true;
  #publishedIndex: Buffer | undefined;
  #storedRevision: string | undefined;
  #baseline: string | undefined;
  readonly #blocks: AnalysisCacheBlocks;
  installationGate?: InstallationLockGate;
  readonly path: string;
  readonly identity: string;
  constructor(options: CacheStoreOptions) {
    this.#options = options;
    this.identity = options.identity;
    this.path = resolveArtifactNamespacePath(
      options.namespace,
      'cache',
      'analysis-v2',
      analysisHash(options.configPath),
      'index.liminainfo',
    );
    this.#blocks = new AnalysisCacheBlocks(
      options.namespace,
      path.dirname(this.path),
    );
  }

  #readBytes(): Buffer | undefined {
    try {
      return readAnalysisCacheFile(this.#options.namespace, this.path);
    } catch (error) {
      if (!isAbsent(error)) this.#hasBaseline = false;
      return undefined;
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
      const { index, writtenBytes } = await this.#blocks.write(snapshot);
      await writeJsonAtomically(this.#options.namespace, this.path, index, {
        serialize: () => {
          encoded = JSON.stringify(index);
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
      this.#publishedIndex = Buffer.from(`${encoded}\n`);
      this.#baseline = physicalRevision(this.#publishedIndex);
      this.#storedRevision = snapshot.header.revision;
      this.#record({
        name: 'analysis-cache',
        kind: 'write',
        durationMs: performance.now() - start,
        estimatedBytes: Buffer.byteLength(encoded) + 1 + writtenBytes,
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
      const snapshot = snapshotModel(cache);
      snapshot.header.baselineTime = Date.now();
      if (this.installationGate?.usable)
        snapshot.header.installations =
          this.installationGate.receipts(snapshot);
      await this.#write(snapshot, async () => {
        await assertCurrent();
        this.installationGate?.assertStable();
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
      !this.installationGate?.needsCheckpoint,
      !cache.inputs.needsCheckpoint,
      cache.isUnchanged(),
    ].every(Boolean);
  }
  #readMeasuredBytes(): Buffer | undefined {
    const start = performance.now();
    const bytes = this.#readBytes();
    this.#recordReadBytes(bytes, start);
    return bytes;
  }
  #recordReadBytes(bytes: Buffer | undefined, start: number): void {
    this.#record({
      name: 'analysis-cache',
      kind: 'read-bytes',
      durationMs: performance.now() - start,
      estimatedBytes: bytes?.length ?? 0,
    });
  }
  #decodeSnapshot(
    bytes: Buffer | undefined,
    shouldRestore: boolean,
  ): AnalysisSnapshot | undefined {
    return new AnalysisSnapshotDecoder({
      ...this.#options,
      admit: (header) => this.#admit(header),
      readBlock: (reference) => {
        const start = performance.now();
        const bytes = this.#blocks.read(reference);
        this.#record({
          name: 'analysis-cache',
          kind: 'read-block',
          durationMs: performance.now() - start,
          estimatedBytes: bytes.length,
          count: 1,
        });
        return bytes;
      },
    }).decode(bytes, shouldRestore);
  }

  #admit(
    header: AnalysisSnapshot['header'] | undefined,
    isInMemory = false,
  ): boolean {
    try {
      return this.#observeInstallations(header, isInMemory);
    } catch (error) {
      if (!(error instanceof AnalysisInputDriftError)) throw error;
      this.#record({
        name: 'analysis-cache',
        kind: 'lockGateRetries',
        count: 1,
      });
      return this.#observeInstallations(undefined, false);
    }
  }
  #observeInstallations(
    header: AnalysisSnapshot['header'] | undefined,
    isInMemory: boolean,
  ): boolean {
    const { governanceRoot, configPath } = this.#options;
    if (governanceRoot === undefined) return true;
    this.installationGate = new InstallationLockGate(
      governanceRoot,
      configPath,
      header,
      (kind) => this.#record({ name: 'analysis-cache', kind, count: 1 }),
    );
    const isAdmitted = this.installationGate.admit(isInMemory);
    this.#record({
      name: 'analysis-cache',
      kind: isAdmitted ? 'lockGateHits' : 'lockGateMisses',
      count: 1,
    });
    return isAdmitted;
  }
  #canPublish(cache: NativeAnalysisCache): boolean {
    return [
      this.#hasBaseline,
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
  refresh(
    cache: NativeAnalysisCache,
    reason?: 'producer-handoff',
  ): AnalysisSnapshot | undefined {
    if (this.#publishedIndex !== undefined) {
      const requiresCold = this.installationGate?.requiresCold;
      const committed = this.#decodeSnapshot(
        this.#publishedIndex,
        !requiresCold,
      );
      this.#publishedIndex = undefined;
      return committed;
    }
    // The next epoch reads the detached candidate as its previous model.
    // A producer visits only its own slice. Let the consumer validate the
    // original generation, including proof contexts the producer never opened.
    const prior = cache.previous;
    const canReuseBaseline =
      reason === 'producer-handoff' &&
      prior?.header.baselineTime !== undefined &&
      !cache.inputs.domainDirty &&
      Object.entries(prior.inputs).every(([inputId, input]) =>
        cache.inputs.valid({ inputId, expectedVersion: input.version }),
      );
    const previous =
      canReuseBaseline || cache.isUnchanged()
        ? cache.previous!
        : cloneAnalysisSnapshot(snapshotModel(cache), true);
    if (this.#options.governanceRoot === undefined) return previous;
    const wasUsable =
      this.installationGate?.usable && !this.installationGate.requiresCold;
    const isInMemory = previous.header.baselineTime === undefined;
    const header = isInMemory
      ? {
          ...previous.header,
          baselineTime: undefined,
          installations: this.installationGate?.receipts(previous),
        }
      : previous.header;
    const isAdmitted = this.#admit(header, isInMemory);
    if (wasUsable && isAdmitted) return previous;
    this.#options.configuration?.capture();
    return undefined;
  }
  read(options: { restore?: boolean } = {}): AnalysisSnapshot | undefined {
    const start = performance.now();
    this.#hasBaseline = true;
    const bytes = this.#readMeasuredBytes();
    this.#baseline = physicalRevision(bytes);
    // A forced cold start still needs the physical publication baseline.
    const shouldRestore =
      options.restore !== false && !this.installationGate?.requiresCold;
    const snapshot = this.#decodeSnapshot(bytes, shouldRestore);
    this.#publishedIndex = undefined;
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
    assertCurrent: () => void | Promise<void> = () => {
      // Direct callers have no additional invocation observations.
    },
  ): Promise<void> {
    this.installationGate?.assertStable();
    if (!this.#canPublish(cache)) {
      await assertCurrent();
      cache.inputs.assertStable();
      return;
    }
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
function isStorageError(error: unknown): boolean {
  return error instanceof Error && 'code' in error;
}

function isAbsent(error: unknown): boolean {
  return ['ENOENT', 'ENOTDIR'].includes(
    String((error as NodeJS.ErrnoException).code),
  );
}
