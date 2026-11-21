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
import { InstallationLockGate } from '../core/analysis-cache/installation-gate';
import type { NativeAnalysisCache } from '../core/analysis-cache/native-cache';
import {
  cacheCause,
  type CacheOrigin,
} from '../core/analysis-cache/profile-decisions';
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
  admissionDecision?: string;
  candidateOrigin: CacheOrigin = 'unknown';
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
    const profile = currentProfile();
    let encoded = '';
    let rejection: string | undefined;
    let isCommitted = false;
    let bookkeeping: string | undefined;
    try {
      const { index, writtenBytes } = await this.#blocks.write(snapshot);
      await writeJsonAtomically(this.#options.namespace, this.path, index, {
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
          this.#recordPublication('published');
          bookkeeping = profile?.start('snapshot.post-commit-bookkeeping');
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
      if (this.installationGate !== undefined)
        snapshot.header.installations =
          this.installationGate.receipts(snapshot);
      await this.#write(snapshot, async () => {
        await assertCurrent();
        this.installationGate?.assertStable();
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
    options?: { physicalLookup?: string; skipCode?: string },
  ): AnalysisSnapshot | undefined {
    const decoder = new AnalysisSnapshotDecoder({
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
    });
    const result = decoder.decode(bytes, shouldRestore, options);
    this.admissionDecision = decoder.decision;
    return result;
  }

  #admit(
    header: AnalysisSnapshot['header'] | undefined,
    isInMemory = false,
  ): { admitted: boolean; decision?: string } {
    try {
      return this.#observeInstallations(header, isInMemory);
    } catch (error) {
      if (!(error instanceof AnalysisInputDriftError)) throw error;
      this.#record({
        name: 'analysis-cache',
        kind: 'lockGateRetries',
        count: 1,
      });
      const profile = currentProfile();
      const decision = profile?.decision(
        'installation-locks',
        {
          stage: 'admission',
          outcome: 'rejected',
          causes: [
            {
              code: 'installation-drift',
              input: {
                kind: 'installation',
                ref: profile.path(error.inputPath),
              },
            },
          ],
        },
        profile.path(this.#options.configPath),
      );
      const current = this.#observeInstallations(undefined, false);
      return { ...current, decision };
    }
  }
  #observeInstallations(
    header: AnalysisSnapshot['header'] | undefined,
    isInMemory: boolean,
  ): { admitted: boolean; decision?: string } {
    const { governanceRoot, configPath } = this.#options;
    if (governanceRoot === undefined) return { admitted: true };
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
    const profile = currentProfile();
    const decision =
      header === undefined
        ? undefined
        : profile?.decision(
            'installation-locks',
            isAdmitted
              ? { stage: 'admission', outcome: 'admitted' }
              : {
                  stage: 'admission',
                  outcome: 'rejected',
                  causes: [
                    this.installationGate.admissionCause(
                      profile.path.bind(profile),
                    ),
                  ],
                },
            profile.path(configPath),
          );
    return { admitted: isAdmitted, decision };
  }
  #publicationBlocker(cache: NativeAnalysisCache): string | undefined {
    if (!this.#hasBaseline) return 'baseline-unreadable';
    if (this.#options.configVersion === undefined)
      return 'configuration-version-unknown';
    if (cache.configVersion !== this.#options.configVersion)
      return 'configuration-version-changed';
    return this.#options.governanceRoot !== undefined &&
      this.installationGate?.usable !== true
      ? 'installation-unproven'
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
      const requiresCold = this.installationGate?.requiresCold;
      const committed = this.#decodeSnapshot(
        this.#publishedIndex,
        !requiresCold,
        { skipCode: requiresCold ? 'installation-requires-cold' : undefined },
      );
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
      !cache.inputs.domainDirty &&
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
    const admission = this.#admit(header, isInMemory);
    const canAdopt = wasUsable && admission.admitted;
    const profile = currentProfile();
    if (profile !== undefined) {
      const basis = [cache.snapshotDecision, admission.decision].filter(
        (decision): decision is string => decision !== undefined,
      );
      this.admissionDecision = profile.decision(
        'analysis-snapshot',
        canAdopt
          ? { stage: 'admission', outcome: 'admitted', basis }
          : {
              stage: 'admission',
              outcome: 'rejected',
              causes: [
                cacheCause(
                  admission.admitted ? undefined : admission.decision,
                  'cached-installation-unusable',
                ),
              ],
              basis,
            },
        profile.path(this.#options.configPath),
      );
    }
    if (canAdopt) return previous;
    this.#options.configuration?.capture();
    return undefined;
  }
  read(options: { restore?: boolean } = {}): AnalysisSnapshot | undefined {
    const start = performance.now();
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
    const shouldRestore =
      options.restore !== false && !this.installationGate?.requiresCold;
    const snapshot = this.#decodeSnapshot(bytes, shouldRestore, {
      physicalLookup,
      skipCode:
        options.restore === false
          ? 'force-skip-restore'
          : shouldRestore
            ? undefined
            : 'installation-requires-cold',
    });
    this.candidateOrigin = 'prior-disk';
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
    try {
      this.installationGate?.assertStable();
    } catch (error) {
      if (!(error instanceof AnalysisInputDriftError))
        this.#recordPublication('failed', 'installation-observation-failed');
      throw error;
    }
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
