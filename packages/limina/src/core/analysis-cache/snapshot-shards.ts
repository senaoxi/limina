import { compareCodeUnits } from '#utils/collections';
import { isPlainRecord } from '#utils/values';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AnalysisSnapshot } from './contracts';
import { packAnalysisRecord, unpackAnalysisRecord } from './record-payload';
import { unpackRecordTable } from './record-table';
import { packSharedRecordTables } from './shared-record-table';
import {
  decodeAnalysisRecords,
  encodeAnalysisRecords,
} from './snapshot-receipts';

type Records = Omit<AnalysisSnapshot, 'header' | 'configModules'>;
type Group = keyof Records;
const groups = Object.keys(emptyRecords()) as Group[];
export const ANALYSIS_STORAGE = 5;
export interface AnalysisBlockReference {
  scope: string | null;
  kind: 'facts' | 'pool';
  digest: string;
  bytes: number;
}
interface AnalysisBlockStorage {
  version: typeof ANALYSIS_STORAGE;
  blocks: AnalysisBlockReference[];
}
const reference: z.ZodType<AnalysisBlockReference> = z.strictObject({
  scope: z.string().nullable(),
  kind: z.enum(['facts', 'pool']),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().positive(),
});
const storage: z.ZodType<AnalysisBlockStorage> = z.strictObject({
  version: z.literal(ANALYSIS_STORAGE),
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
    contexts: {},
    vueContexts: {},
    sourceConfigs: {},
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
    contexts: (id) => contextScope(snapshot, id),
    projects: (id) => contextScope(snapshot, id),
    vueContexts: (id) => snapshot.vueContexts[id]!.project.configPath,
    sourceConfigs: (id) => id,
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
  const entries = [...partition(snapshot)];
  const packed = packSharedRecordTables(
    entries.values().map(([, records]) => encodeAnalysisRecords(records)),
  );
  // Capture every scope before yielding control to asynchronous block storage.
  yield encodeBlock('pool:context-facts-v1', 'pool', packed.shared);
  for (const [index, [scope]] of entries.entries())
    yield encodeBlock(scope, 'facts', packed.tables[index]);
}

function encodeBlock(
  scope: string | null,
  kind: AnalysisBlockReference['kind'],
  value: unknown,
) {
  const text = `${JSON.stringify({
    scope,
    kind,
    payload: packAnalysisRecord(value, 'json', 'brotli'),
  })}\n`;
  return {
    reference: {
      scope,
      kind,
      digest: analysisBlockDigest(text),
      bytes: Buffer.byteLength(text),
    },
    text,
  };
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
  if (Object.keys(source).length !== groups.length)
    throw new Error('Unexpected analysis record groups.');
  for (const group of groups) {
    const entries = Object.entries(requireRecord(source[group]));
    for (const [id, value] of entries) addRecord(target[group], id, value);
  }
}
function readPayload(block: AnalysisBlockReference, bytes: Buffer): unknown {
  const matches = [
    bytes.length === block.bytes,
    analysisBlockDigest(bytes) === block.digest,
  ];
  if (!matches.every(Boolean))
    throw new Error('Analysis block content changed.');
  const parsed = requireRecord(JSON.parse(bytes.toString('utf8')));
  if (parsed.scope !== block.scope)
    throw new Error('Analysis block scope changed.');
  if (parsed.kind !== block.kind)
    throw new Error('Analysis block category changed.');
  return unpackAnalysisRecord(parsed.payload);
}
function readBlock(
  block: AnalysisBlockReference,
  bytes: Buffer,
  shared: readonly unknown[],
): Record<string, unknown> {
  const table = requireRecord(
    unpackRecordTable(readPayload(block, bytes), shared),
  );
  return decodeAnalysisRecords(table);
}
function addScope(scopes: Set<string | null>, scope: string | null): void {
  if (scopes.has(scope)) throw new Error('Duplicate analysis scope.');
  scopes.add(scope);
}
export function readAnalysisBlocks(
  value: unknown,
  read: (reference: AnalysisBlockReference) => Buffer,
): unknown {
  const root = requireRecord(value);
  const { blocks } = storage.parse(root.storage);
  const scopes = new Set<string | null>();
  for (const block of blocks) addScope(scopes, block.scope);
  const pools = blocks.filter((block) => block.kind === 'pool');
  if (pools.length !== 1)
    throw new Error('Missing or duplicate shared record pool.');
  const facts = blocks.filter((block) => block.kind === 'facts');
  if (facts.every((block) => block.scope !== null))
    throw new Error('Missing analysis input ledger.');
  const [pool] = pools;
  const shared = unpackRecordTable(readPayload(pool, read(pool)));
  if (!Array.isArray(shared)) throw new Error('Invalid shared record pool.');
  const records = emptyRecords();
  for (const block of facts)
    mergeRecords(records, readBlock(block, read(block), shared));
  return { header: root.header, configModules: root.configModules, ...records };
}
