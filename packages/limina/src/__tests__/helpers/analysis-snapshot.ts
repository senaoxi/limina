import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AnalysisSnapshot } from '../../core/analysis-cache/contracts';
import { decodeData, encodeData } from '../../core/analysis-cache/data-codec';
import { analysisHash } from '../../core/analysis-cache/identity';
import { cloneAnalysisSnapshot } from '../../core/analysis-cache/snapshot-receipts';
import {
  type AnalysisBlockReference,
  type AnalysisSnapshotIndex,
  encodeAnalysisBlocks,
  readAnalysisBlocks,
} from '../../core/analysis-cache/snapshot-shards';

// Inspect or corrupt the persisted projection; its native fields are references,
// not reconstituted proof. Native completeness tests mutate the context owner.
export function decodeGraphProjection(data: unknown): unknown {
  return (decodeData(data) as { projection: unknown }).projection;
}
export function encodeGraphProjection(projection: unknown) {
  return encodeData({ format: 'native-context-views-v1', projection });
}

export function analysisBlockPath(
  file: string,
  block: AnalysisBlockReference,
): string {
  return path.join(
    path.dirname(file),
    'scopes',
    block.scope === null ? 'shared' : analysisHash(block.scope),
    `${block.digest}.liminainfo`,
  );
}
export function readStoredAnalysisSnapshot(file: string): AnalysisSnapshot {
  const index = JSON.parse(readFileSync(file, 'utf8'));
  const snapshot = readAnalysisBlocks(index, (block) =>
    readFileSync(analysisBlockPath(file, block)),
  ) as AnalysisSnapshot;
  return cloneAnalysisSnapshot(snapshot);
}
// Corrupt semantic DTOs inside a valid storage envelope so regressions reach
// coverage/freshness validation rather than merely failing a block digest.
export function writeStoredAnalysisSnapshot(
  file: string,
  snapshot: AnalysisSnapshot,
): void {
  const blocks: AnalysisBlockReference[] = [];
  for (const block of encodeAnalysisBlocks(snapshot)) {
    const target = analysisBlockPath(file, block.reference);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, block.text);
    blocks.push(block.reference);
  }
  const index: AnalysisSnapshotIndex = {
    header: snapshot.header,
    configModules: snapshot.configModules,
    storage: { version: 3, blocks },
  };
  writeFileSync(file, JSON.stringify(index));
}

// Exercise the production block codec without giving semantic unit tests a
// second filesystem store. Store/process tests own physical publication.
export function roundTripAnalysisSnapshot(snapshot: AnalysisSnapshot): unknown {
  const blocks = [...encodeAnalysisBlocks(snapshot)];
  const contents = new Map(
    blocks.map((block) => [block.reference.digest, Buffer.from(block.text)]),
  );
  const index: AnalysisSnapshotIndex = {
    header: snapshot.header,
    configModules: snapshot.configModules,
    storage: { version: 3, blocks: blocks.map((block) => block.reference) },
  };
  const text = JSON.stringify(index);
  return readAnalysisBlocks(
    JSON.parse(text),
    (block) => contents.get(block.digest)!,
  );
}
