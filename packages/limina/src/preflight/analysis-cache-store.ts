import { createHash } from 'node:crypto';
import { rename } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import path from 'pathe';
import type { AnalysisMetricsRecorder } from '../application/analysis/analysis-run';
import { currentProfile } from '../application/analysis/observability';
import { writeJsonAtomically } from '../check-reporting/atomic-writer';
import {
  AnalysisInputDriftError,
  type AnalysisSnapshot,
} from '../core/analysis-cache/contracts';
import { analysisHash } from '../core/analysis-cache/identity';
import type { NativeAnalysisCache } from '../core/analysis-cache/native-cache';
import type { CacheOrigin } from '../core/analysis-cache/profile-decisions';
import { cloneAnalysisSnapshot } from '../core/analysis-cache/snapshot-receipts';
import { snapshotModel } from '../core/analysis-cache/snapshot-records';
import {
  assertArtifactPathOperationSafe,
  type LiminaArtifactNamespace,
  resolveArtifactNamespacePath,
} from '../domain/artifacts/namespace';
import {
  acquireCrossProcessWriteLease,
  type CrossProcessLease,
} from '../utils/mutation/cross-process-lease';
import {
  AnalysisCacheBlocks,
  readAnalysisCacheFile,
} from './analysis-cache-blocks';
import { AnalysisSnapshotDecoder } from './analysis-cache-decode';
import type { ConfigObservation } from './config-observation';
import {
  injectedAnalysisMetrics,
  recordSnapshotPublication,
  snapshotWriteObserver,
} from './profile-metrics';

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
  readonly #diagnosticMetrics: AnalysisMetricsRecorder | undefined;
  #hasBaseline = true;
  #publishedIndex: Buffer | undefined;
  #storedRevision: string | undefined;
  #baseline: string | undefined;
  readonly #blocks: AnalysisCacheBlocks;
  admissionDecision?: string;
  candidateOrigin: CacheOrigin = 'unknown';
  readonly path: string;
  readonly identity: string;
  constructor(options: CacheStoreOptions) {
    this.#options = options;
    this.#diagnosticMetrics = injectedAnalysisMetrics(options.metrics);
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

  #readBytes(operation: 'read-bytes' | 'check-baseline'): Buffer | undefined {
    try {
      return readAnalysisCacheFile(
        this.#options.namespace,
        this.path,
        operation,
      );
    } catch (error) {
      if (!isAbsent(error)) this.#hasBaseline = false;
      return undefined;
    }
  }

  #isBaselineCurrent(): boolean {
    const bytes = this.#readBytes('check-baseline');
    return this.#hasBaseline && physicalRevision(bytes) === this.#baseline;
  }

  #record(measurement: Parameters<AnalysisMetricsRecorder['record']>[0]): void {
    this.#diagnosticMetrics?.record(measurement);
  }

  async #write(
    snapshot: AnalysisSnapshot,
    assertCurrent: () => void | Promise<void>,
  ): Promise<void> {
    const profile = currentProfile();
    const start =
      profile === undefined && this.#diagnosticMetrics === undefined
        ? undefined
        : performance.now();
    let encoded = '';
    let rejection: string | undefined;
    let isCommitted = false;
    let bookkeeping: string | undefined;
    try {
      const { index, writtenBytes } = await this.#blocks.write(snapshot);
      await writeJsonAtomically(this.#options.namespace, this.path, index, {
        observePayloadWrite: snapshotWriteObserver('write-index'),
        serialize: () => {
          encoded = JSON.stringify(index);
          return encoded;
        },
        rename: async (from, to) => {
          try {
            await assertPublicationCurrent(assertCurrent);
          } catch (error) {
            rejection = 'publication-observation-failed';
            throw error;
          }
          if (!this.#isBaselineCurrent()) {
            rejection = this.#hasBaseline
              ? 'baseline-changed-before-replacement'
              : 'baseline-unreadable-before-replacement';
            throw new Error(
              'Analysis snapshot revision changed before publication.',
            );
          }
          await rename(from, to);
          isCommitted = true;
          if (profile !== undefined && start !== undefined)
            recordSnapshotPublication(
              profile,
              performance.now() - start,
              Buffer.byteLength(encoded) + 1 + writtenBytes,
            );
          this.#recordPublication('published');
          bookkeeping = profile?.start('snapshot.post-commit-bookkeeping');
        },
      });
      this.#publishedIndex = Buffer.from(`${encoded}\n`);
      this.#baseline = physicalRevision(this.#publishedIndex);
      this.#storedRevision = snapshot.header.revision;
      if (start !== undefined && this.#diagnosticMetrics !== undefined)
        this.#record({
          name: 'analysis-cache',
          kind: 'write',
          durationMs: performance.now() - start,
          estimatedBytes: this.#publishedIndex.length + writtenBytes,
        });
      if (bookkeeping !== undefined) profile?.finish(bookkeeping);
    } catch (error) {
      // Only storage I/O is best effort; drift and authorization failures stop
      // publication and must not be converted into a successful check.
      if (bookkeeping !== undefined)
        profile?.finish(
          bookkeeping,
          'failed',
          'post-commit-bookkeeping-failed',
        );
      if (!isCommitted) {
        this.#recordPublication(
          'failed',
          rejection ??
            (isStorageError(error)
              ? 'storage-write-failed'
              : 'publication-write-failed'),
        );
      }
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
    const lease = await this.#publicationLease(namespace, configPath);
    try {
      try {
        await assertCurrent();
        cache.inputs.assertStable();
      } catch (error) {
        if (!(error instanceof AnalysisInputDriftError))
          this.#recordPublication('failed', 'publication-observation-failed');
        throw error;
      }
      if (!this.#isBaselineCurrent()) {
        this.#recordPublication(
          'not-published',
          this.#hasBaseline
            ? 'writer-superseded'
            : 'baseline-unreadable-before-write',
        );
        return;
      }
      const snapshot = snapshotModel(cache);
      snapshot.header.baselineTime = Date.now();
      await this.#write(snapshot, async () => {
        await assertCurrent();
        cache.inputs.assertStable();
      });
    } finally {
      await this.#releaseLease(lease);
    }
  }

  async #releaseLease(lease: CrossProcessLease): Promise<void> {
    const profile = currentProfile();
    const release = profile?.start('snapshot.lease-release');
    try {
      await lease.release();
      if (release !== undefined) profile?.finish(release);
    } catch (error) {
      if (release !== undefined)
        profile?.finish(release, 'failed', 'lease-release-failed');
      throw error;
    }
  }

  async #publicationLease(
    namespace: LiminaArtifactNamespace,
    configPath: string,
  ) {
    try {
      await assertArtifactPathOperationSafe(namespace, this.path);
    } catch (error) {
      this.#recordPublication('failed', 'publication-path-rejected');
      throw error;
    }
    try {
      return await acquireCrossProcessWriteLease(namespace.canonicalRootDir, {
        leaseName: `analysis-${analysisHash(configPath)}`,
      });
    } catch (error) {
      this.#recordPublication('failed', 'publication-lease-unavailable');
      throw error;
    }
  }

  #recordPublication(
    outcome: 'published' | 'not-published' | 'failed',
    code?: string,
  ): void {
    const profile = currentProfile();
    profile?.decision(
      'analysis-snapshot',
      outcome === 'published'
        ? { stage: 'publication', outcome }
        : {
            stage: 'publication',
            outcome,
            causes: [{ code: code ?? 'publication-failed' }],
          },
      profile.path(this.#options.configPath),
    );
  }
  #isStoredModelUnchanged(cache: NativeAnalysisCache): boolean {
    return [
      this.#storedRevision !== undefined,
      cache.previous?.header.revision === this.#storedRevision,
      !cache.inputs.needsCheckpoint,
      cache.isUnchanged(),
    ].every(Boolean);
  }
  #readMeasuredBytes(): Buffer | undefined {
    const start =
      this.#diagnosticMetrics === undefined ? undefined : performance.now();
    const bytes = this.#readBytes('read-bytes');
    if (start !== undefined)
      this.#record({
        name: 'analysis-cache',
        kind: 'read-bytes',
        durationMs: performance.now() - start,
        estimatedBytes: bytes?.length ?? 0,
      });
    return bytes;
  }
  #decodeSnapshot(
    bytes: Buffer | undefined,
    shouldRestore: boolean,
    options?: { physicalLookup?: string; skipCode?: string },
  ): AnalysisSnapshot | undefined {
    const decoder = new AnalysisSnapshotDecoder({
      ...this.#options,
      metrics: this.#diagnosticMetrics,
      readBlock: (reference) => {
        const start =
          this.#diagnosticMetrics === undefined ? undefined : performance.now();
        const bytes = this.#blocks.read(reference, 'read-block');
        if (start !== undefined)
          this.#record({
            name: 'analysis-cache',
            kind: 'read-block',
            durationMs: performance.now() - start,
            estimatedBytes: bytes.length,
            count: 1,
          });
        return bytes;
      },
    });
    const result = decoder.decode(bytes, shouldRestore, options);
    this.admissionDecision = decoder.decision;
    return result;
  }

  #publicationBlocker(cache: NativeAnalysisCache): string | undefined {
    if (!this.#hasBaseline) return 'baseline-unreadable';
    if (this.#options.configVersion === undefined)
      return 'configuration-version-unknown';
    if (cache.configVersion !== this.#options.configVersion)
      return 'configuration-version-changed';
    return cache.hasIncompleteNativeCollection
      ? 'native-collection-incomplete'
      : undefined;
  }
  async #publishQualified(
    cache: NativeAnalysisCache,
    assertCurrent: () => void | Promise<void>,
  ): Promise<void> {
    if (this.#isStoredModelUnchanged(cache)) {
      await assertCurrent();
      cache.inputs.assertStable();
      this.#record({ name: 'analysis-cache', kind: 'unchanged', count: 1 });
      this.#recordPublication('not-published', 'snapshot-unchanged');
      return;
    }
    await this.#publishChanged(cache, assertCurrent);
  }
  refresh(
    cache: NativeAnalysisCache,
    reason?: 'producer-handoff',
  ): AnalysisSnapshot | undefined {
    this.admissionDecision = undefined;
    if (this.#publishedIndex !== undefined) {
      const committed = this.#decodeSnapshot(this.#publishedIndex, true);
      this.#publishedIndex = undefined;
      this.candidateOrigin = 'invocation-memory';
      return committed;
    }
    // The next epoch reads the detached candidate as its previous model.
    // Keep unopened consumer contexts only if the prior generation also
    // contains the producer's current Native contexts. New roots can replace
    // those contexts while every previously recorded file remains unchanged.
    const prior = cache.previous;
    const canReuseBaseline =
      reason === 'producer-handoff' &&
      prior?.header.baselineTime !== undefined &&
      !cache.inputs.toolchainChanged &&
      analysisHash(prior.header.packageScopes) ===
        analysisHash(cache.packageScopes) &&
      Object.entries(cache.contexts).every(
        ([id, context]) => prior.contexts[id] === context,
      ) &&
      Object.entries(prior.inputs).every(([inputId, input]) =>
        cache.inputs.valid({ inputId, expectedVersion: input.version }),
      );
    const previous =
      canReuseBaseline || cache.isUnchanged()
        ? cache.previous!
        : cloneAnalysisSnapshot(snapshotModel(cache), true);
    this.candidateOrigin =
      previous === cache.previous ? cache.previousOrigin : 'invocation-memory';
    return previous;
  }
  read(options: { restore?: boolean } = {}): AnalysisSnapshot | undefined {
    const start =
      this.#diagnosticMetrics === undefined ? undefined : performance.now();
    this.#hasBaseline = true;
    const bytes = this.#readMeasuredBytes();
    this.#baseline = physicalRevision(bytes);
    const profile = currentProfile();
    const physicalLookup = profile?.decision(
      'analysis-snapshot',
      bytes === undefined
        ? {
            stage: 'lookup',
            outcome: this.#hasBaseline ? 'absent' : 'unavailable',
            causes: [
              {
                code: this.#hasBaseline
                  ? 'no-physical-baseline'
                  : 'baseline-unreadable',
              },
            ],
          }
        : { stage: 'lookup', outcome: 'found' },
      profile.path(this.#options.configPath),
    );
    // A forced cold start still needs the physical publication baseline.
    const shouldRestore = options.restore !== false;
    const snapshot = this.#decodeSnapshot(bytes, shouldRestore, {
      physicalLookup,
      skipCode: shouldRestore ? undefined : 'force-skip-restore',
    });
    this.candidateOrigin = 'prior-disk';
    this.#publishedIndex = undefined;
    this.#storedRevision = snapshot?.header.revision;
    if (start !== undefined)
      this.#diagnosticMetrics?.record({
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
    const blocker = this.#publicationBlocker(cache);
    if (blocker !== undefined) {
      await assertCurrent();
      cache.inputs.assertStable();
      this.#recordPublication('not-published', blocker);
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
