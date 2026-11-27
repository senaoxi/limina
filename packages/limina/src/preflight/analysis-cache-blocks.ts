import { lstatSync, readFileSync } from 'node:fs';
import { readdir, rmdir, unlink } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import path from 'pathe';
import { currentProfile } from '../application/analysis/observability';
import { writeJsonAtomically } from '../check-reporting/atomic-writer';
import type { AnalysisSnapshot } from '../core/analysis-cache/contracts';
import { analysisHash } from '../core/analysis-cache/identity';
import {
  ANALYSIS_STORAGE,
  analysisBlockDigest,
  type AnalysisBlockReference,
  type AnalysisSnapshotIndex,
  encodeAnalysisBlocks,
} from '../core/analysis-cache/snapshot-shards';
import {
  assertArtifactPathLexicallyContained,
  type LiminaArtifactNamespace,
} from '../domain/artifacts/namespace';
import {
  assertArtifactPathStatsSafe,
  getRelativeSegments,
} from '../domain/artifacts/namespace-safety-shared';
import {
  recordSnapshotIo,
  type SnapshotReadOperation,
  snapshotWriteObserver,
} from './profile-metrics';

export function readAnalysisCacheFile(
  namespace: LiminaArtifactNamespace,
  file: string,
  operation: SnapshotReadOperation,
): Buffer {
  assertArtifactPathLexicallyContained(namespace, file);
  let cursor = namespace.rootDir;
  for (const segment of ['', ...getRelativeSegments(namespace, file)]) {
    cursor = path.join(cursor, segment);
    const role = cursor === file ? 'target-file' : 'parent-directory';
    assertArtifactPathStatsSafe(cursor, lstatSync(cursor), new Set([role]));
  }
  const profile = currentProfile();
  if (profile === undefined) return readFileSync(file);
  const start = performance.now();
  let bytes: Buffer | undefined;
  try {
    bytes = readFileSync(file);
    return bytes;
  } finally {
    recordSnapshotIo(
      profile,
      operation,
      performance.now() - start,
      bytes?.length,
    );
  }
}

export interface AnalysisCacheGcReport {
  readonly activeReferencedBytes: number;
  readonly retainedBytes: number;
  readonly reclaimedBytes: number;
  readonly reclaimedBlocks: number;
}

export const DEFAULT_ANALYSIS_CACHE_GC_GRACE_MS: number = 10 * 60 * 1000;

export class AnalysisCacheBlocks {
  readonly #namespace: LiminaArtifactNamespace;
  readonly #directory: string;
  constructor(namespace: LiminaArtifactNamespace, directory: string) {
    this.#namespace = namespace;
    this.#directory = directory;
  }

  #path(block: AnalysisBlockReference): string {
    const owner = block.scope === null ? 'shared' : analysisHash(block.scope);
    return path.join(
      this.#directory,
      'scopes',
      owner,
      `${block.digest}.liminainfo`,
    );
  }
  #hasContent(block: AnalysisBlockReference): boolean {
    try {
      const bytes = this.read(block, 'check-block');
      return (
        bytes.length === block.bytes &&
        analysisBlockDigest(bytes) === block.digest
      );
    } catch {
      return false;
    }
  }
  read(
    block: AnalysisBlockReference,
    operation: 'read-block' | 'check-block',
  ): Buffer {
    return readAnalysisCacheFile(this.#namespace, this.#path(block), operation);
  }
  async write(
    snapshot: AnalysisSnapshot,
  ): Promise<{ index: AnalysisSnapshotIndex; writtenBytes: number }> {
    const header = structuredClone(snapshot.header);
    const configModules = structuredClone(snapshot.configModules);
    const blocks: AnalysisBlockReference[] = [];
    const observePayloadWrite = snapshotWriteObserver('write-block');
    let writtenBytes = 0;
    for (const block of encodeAnalysisBlocks(snapshot)) {
      if (!this.#hasContent(block.reference)) {
        await writeJsonAtomically(
          this.#namespace,
          this.#path(block.reference),
          null,
          {
            observePayloadWrite,
            serialize: () => block.text.trimEnd(),
          },
        );
        writtenBytes += block.reference.bytes;
      }
      blocks.push(block.reference);
    }
    return {
      index: {
        header,
        configModules,
        storage: { version: ANALYSIS_STORAGE, blocks },
      },
      writtenBytes,
    };
  }

  async sweepUnreachable(
    activeBlocks: readonly AnalysisBlockReference[],
    options: { graceMs?: number; now?: number } = {},
  ): Promise<AnalysisCacheGcReport> {
    const graceMs = options.graceMs ?? DEFAULT_ANALYSIS_CACHE_GC_GRACE_MS;
    const now = options.now ?? Date.now();
    const activePaths = new Set(activeBlocks.map((block) => this.#path(block)));
    const activeReferencedBytes = activeBlocks.reduce(
      (sum, block) => sum + block.bytes,
      0,
    );
    const scopesDirectory = path.join(this.#directory, 'scopes');
    let retainedBytes = 0;
    let reclaimedBytes = 0;
    let reclaimedBlocks = 0;
    let scopeEntries: string[];
    try {
      scopeEntries = await readdir(scopesDirectory);
    } catch {
      return {
        activeReferencedBytes,
        retainedBytes: activeReferencedBytes,
        reclaimedBytes: 0,
        reclaimedBlocks: 0,
      };
    }
    for (const scopeName of scopeEntries) {
      const scopeDirectory = path.join(scopesDirectory, scopeName);
      let blockFiles: string[];
      try {
        assertArtifactPathLexicallyContained(this.#namespace, scopeDirectory);
        const scopeStats = lstatSync(scopeDirectory);
        if (!scopeStats.isDirectory() || scopeStats.isSymbolicLink()) continue;
        blockFiles = await readdir(scopeDirectory);
      } catch {
        continue;
      }
      let remaining = blockFiles.length;
      for (const fileName of blockFiles) {
        if (!fileName.endsWith('.liminainfo')) continue;
        const filePath = path.join(scopeDirectory, fileName);
        try {
          assertArtifactPathLexicallyContained(this.#namespace, filePath);
          const stats = lstatSync(filePath);
          if (!stats.isFile() || stats.isSymbolicLink()) continue;
          if (activePaths.has(filePath)) {
            retainedBytes += stats.size;
            continue;
          }
          if (now - stats.mtimeMs >= graceMs) {
            await unlink(filePath);
            reclaimedBytes += stats.size;
            reclaimedBlocks += 1;
            remaining -= 1;
          } else {
            retainedBytes += stats.size;
          }
        } catch {
          // Best-effort GC must never fail a committed publication.
        }
      }
      if (remaining === 0) {
        try {
          await rmdir(scopeDirectory);
        } catch {
          // Ignore non-empty or concurrently modified scope directories.
        }
      }
    }
    return {
      activeReferencedBytes,
      retainedBytes,
      reclaimedBytes,
      reclaimedBlocks,
    };
  }
}
