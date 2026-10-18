import { compareCodeUnits } from '#utils/collections';
import { isPlainRecord } from '#utils/values';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AnalysisSnapshot } from './contracts';
import { packAnalysisRecord, unpackAnalysisRecord } from './record-payload';
import {
  decodeAnalysisRecords,
  encodeAnalysisRecords,
} from './snapshot-receipts';

type Records = Omit<AnalysisSnapshot, 'header' | 'configModules'>;
type Group = keyof Records;
const groups = Object.keys(emptyRecords()) as Group[];
export interface AnalysisBlockReference {
  scope: string | null;
  digest: string;
  bytes: number;
}
interface AnalysisBlockStorage {
  version: 1;
  blocks: AnalysisBlockReference[];
}
const reference: z.ZodType<AnalysisBlockReference> = z.strictObject({
  scope: z.string().nullable(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().positive(),
});
const storage: z.ZodType<AnalysisBlockStorage> = z.strictObject({
  version: z.literal(1),
  blocks: z.array(reference).min(1),
});
export interface AnalysisSnapshotIndex {
  header: AnalysisSnapshot['header'];
  configModules: AnalysisSnapshot['configModules'];
  storage: AnalysisBlockStorage;
}

export function analysisBlockDigest(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function emptyRecords(): Records {
  return {
    inputs: {},
    files: {},
    queries: {},
    importers: {},
    projects: {},
    contributions: {},
    contexts: {},
    vueContexts: {},
    graphs: {},
  };
}
function contextScope(snapshot: AnalysisSnapshot, id: string): string | null {
  return snapshot.contexts[id]?.project.configPath ?? null;
}
function scopeReaders(
  snapshot: AnalysisSnapshot,
): Record<Group, (id: string) => string | null> {
  const shared = () => null;
  return {
    inputs: shared,
    files: shared,
    contributions: shared,
    graphs: shared,
    contexts: (id) => contextScope(snapshot, id),
    projects: (id) => contextScope(snapshot, id),
    vueContexts: (id) => snapshot.vueContexts[id]!.project.configPath,
    queries: (id) => contextScope(snapshot, snapshot.queries[id]!.contextId),
    importers: (id) =>
      contextScope(snapshot, snapshot.importers[id]!.contextId),
  };
}
function blockRecords(
  blocks: Map<string | null, Records>,
  scope: string | null,
): Records {
  let records = blocks.get(scope);
  if (records === undefined) {
    records = emptyRecords();
    blocks.set(scope, records);
  }
  return records;
}
function partition(snapshot: AnalysisSnapshot): Map<string | null, Records> {
  const blocks = new Map<string | null, Records>([[null, emptyRecords()]]);
  const readers = scopeReaders(snapshot);
  for (const group of groups) {
    const ids = Object.keys(snapshot[group]).sort(compareCodeUnits);
    for (const id of ids) {
      const target: Record<string, unknown> = blockRecords(
        blocks,
        readers[group](id),
      )[group];
      target[id] = snapshot[group][id];
    }
  }
  return blocks;
}

export function* encodeAnalysisBlocks(
  snapshot: AnalysisSnapshot,
): Generator<{ reference: AnalysisBlockReference; text: string }> {
  for (const [scope, records] of partition(snapshot)) {
    const payload = encodeAnalysisRecords(records);
    const text = `${JSON.stringify({
      scope,
      payload: packAnalysisRecord(payload, 'json', 'brotli'),
    })}\n`;
    yield {
      reference: {
        scope,
        digest: analysisBlockDigest(text),
        bytes: Buffer.byteLength(text),
      },
      text,
    };
  }
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isPlainRecord(value)) throw new Error('Invalid analysis block record.');
  return value;
}
function addRecord(
  target: Record<string, unknown>,
  id: string,
  value: unknown,
): void {
  if (Object.hasOwn(target, id)) throw new Error('Duplicate analysis record.');
  Object.defineProperty(target, id, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}
function mergeRecords(target: Records, source: Record<string, unknown>): void {
  for (const group of groups) {
    const entries = Object.entries(requireRecord(source[group]));
    for (const [id, value] of entries) addRecord(target[group], id, value);
  }
}
function readBlock(
  block: AnalysisBlockReference,
  bytes: Buffer,
): Record<string, unknown> {
  const matches = [
    bytes.length === block.bytes,
    analysisBlockDigest(bytes) === block.digest,
  ];
  if (!matches.every(Boolean))
    throw new Error('Analysis block content changed.');
  const parsed = requireRecord(JSON.parse(bytes.toString('utf8')));
  if (parsed.scope !== block.scope)
    throw new Error('Analysis block scope changed.');
  return decodeAnalysisRecords(
    requireRecord(unpackAnalysisRecord(parsed.payload)),
  );
}
function addScope(scopes: Set<string | null>, scope: string | null): void {
  if (scopes.has(scope)) throw new Error('Duplicate analysis scope.');
  scopes.add(scope);
}
function requireSharedScope(scopes: Set<string | null>): void {
  if (!scopes.has(null)) throw new Error('Missing shared analysis block.');
}
export function readAnalysisBlocks(
  value: unknown,
  read: (reference: AnalysisBlockReference) => Buffer,
): unknown {
  const root = requireRecord(value);
  const index = storage.parse(root.storage);
  const scopes = new Set<string | null>();
  const records = emptyRecords();
  for (const block of index.blocks) {
    addScope(scopes, block.scope);
    mergeRecords(records, readBlock(block, read(block)));
  }
  requireSharedScope(scopes);
  return { header: root.header, configModules: root.configModules, ...records };
}
