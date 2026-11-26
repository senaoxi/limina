import { lstatSync, readFileSync } from 'node:fs';
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
}
