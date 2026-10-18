import { lstatSync, readFileSync } from 'node:fs';
import path from 'pathe';
import { writeJsonAtomically } from '../check-reporting/atomic-writer';
import type { AnalysisSnapshot } from '../core/analysis-cache/contracts';
import { analysisHash } from '../core/analysis-cache/identity';
import {
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

export function readAnalysisCacheFile(
  namespace: LiminaArtifactNamespace,
  file: string,
): Buffer {
  assertArtifactPathLexicallyContained(namespace, file);
  let cursor = namespace.rootDir;
  for (const segment of ['', ...getRelativeSegments(namespace, file)]) {
    cursor = path.join(cursor, segment);
    const role = cursor === file ? 'target-file' : 'parent-directory';
    assertArtifactPathStatsSafe(cursor, lstatSync(cursor), new Set([role]));
  }
  return readFileSync(file);
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
      const bytes = this.read(block);
      return (
        bytes.length === block.bytes &&
        analysisBlockDigest(bytes) === block.digest
      );
    } catch {
      return false;
    }
  }
  read(block: AnalysisBlockReference): Buffer {
    return readAnalysisCacheFile(this.#namespace, this.#path(block));
  }
  async write(
    snapshot: AnalysisSnapshot,
  ): Promise<{ index: AnalysisSnapshotIndex; writtenBytes: number }> {
    const blocks: AnalysisBlockReference[] = [];
    let writtenBytes = 0;
    for (const block of encodeAnalysisBlocks(snapshot)) {
      if (!this.#hasContent(block.reference)) {
        await writeJsonAtomically(
          this.#namespace,
          this.#path(block.reference),
          null,
          {
            serialize: () => block.text.trimEnd(),
          },
        );
        writtenBytes += block.reference.bytes;
      }
      blocks.push(block.reference);
    }
    return {
      index: {
        header: snapshot.header,
        configModules: snapshot.configModules,
        storage: { version: 1, blocks },
      },
      writtenBytes,
    };
  }
}
