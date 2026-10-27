import { compareCodeUnits } from '#utils/collections';
import { isPlainRecord } from '#utils/values';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AnalysisSnapshot } from './contracts';
import { packAnalysisRecord, unpackAnalysisRecord } from './record-payload';
import { packRecordTable, unpackRecordTable } from './record-table';
import { packSharedRecordTables } from './shared-record-table';
import {
  decodeAnalysisRecords,
  encodeAnalysisRecords,
} from './snapshot-receipts';

type Records = Omit<AnalysisSnapshot, 'header' | 'configModules'>;
type Group = keyof Records;
const groups = Object.keys(emptyRecords()) as Group[];
export interface AnalysisBlockReference {
  scope: string | null;
  kind: 'facts' | 'graph' | 'pool';
  digest: string;
  bytes: number;
}
interface AnalysisBlockStorage {
  version: 3;
  blocks: AnalysisBlockReference[];
}
const reference: z.ZodType<AnalysisBlockReference> = z.strictObject({
  scope: z.string().nullable(),
  kind: z.enum(['facts', 'graph', 'pool']),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().positive(),
});
const storage: z.ZodType<AnalysisBlockStorage> = z.strictObject({
  version: z.literal(3),
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
    graphs: (id) => `graph:${id}`,
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
  const entries = [...partition(snapshot)];
  const facts = entries.filter(
    ([, records]) => Object.keys(records.graphs).length === 0,
  );
  const packed = packSharedRecordTables(
    facts.map(([, records]) => encodeAnalysisRecords(records)),
  );
  yield encodeBlock('pool:context-facts-v1', 'pool', packed.shared);
  for (const [index, [scope]] of facts.entries())
    yield encodeBlock(scope, 'facts', packed.tables[index]);
  for (const [scope, records] of entries)
    if (Object.keys(records.graphs).length > 0)
      yield encodeBlock(
        scope,
        'graph',
        packRecordTable(encodeAnalysisRecords(records)),
      );
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
  const records = decodeAnalysisRecords(table);
  for (const group of groups)
    if (
      (group === 'graphs') !== (block.kind === 'graph') &&
      Object.keys(requireRecord(records[group])).length > 0
    )
      throw new Error('Analysis block contains facts outside its category.');
  return records;
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
  const blocks = new AnalysisBlockReader(value, read);
  return { ...blocks.facts(), graphs: blocks.graphs() };
}

/**
Separate unloaded projection bytes from a generation's qualified facts.
*/
export class AnalysisBlockReader {
  readonly #root: Record<string, unknown>;
  readonly #index: AnalysisBlockStorage;
  readonly #read: (reference: AnalysisBlockReference) => Buffer;
  #shared: readonly unknown[] | undefined;
  constructor(
    value: unknown,
    read: (reference: AnalysisBlockReference) => Buffer,
  ) {
    this.#root = requireRecord(value);
    this.#index = storage.parse(this.#root.storage);
    this.#read = read;
    const scopes = new Set<string | null>();
    for (const block of this.#index.blocks) addScope(scopes, block.scope);
    requireSharedScope(scopes);
    if (
      this.#index.blocks.every(
        (block) => !(block.scope === null && block.kind === 'facts'),
      )
    )
      throw new Error('Missing analysis input ledger.');
    if (
      this.#index.blocks.filter((block) => block.kind === 'pool').length !== 1
    )
      throw new Error('Missing or duplicate shared record pool.');
  }
  #pool(): readonly unknown[] {
    if (this.#shared !== undefined) return this.#shared;
    const block = this.#index.blocks.find((item) => item.kind === 'pool')!;
    const pool = unpackRecordTable(readPayload(block, this.#read(block)));
    if (!Array.isArray(pool)) throw new Error('Invalid shared record pool.');
    this.#shared = pool;
    return pool;
  }
  #records(kind: 'facts' | 'graph'): Records {
    const records = emptyRecords();
    const shared = kind === 'facts' ? this.#pool() : [];
    for (const block of this.#index.blocks)
      if (block.kind === kind)
        mergeRecords(records, readBlock(block, this.#read(block), shared));
    return records;
  }
  facts(): Record<string, unknown> {
    return {
      header: this.#root.header,
      configModules: this.#root.configModules,
      ...this.#records('facts'),
    };
  }
  graphs(): Records['graphs'] {
    return this.#records('graph').graphs;
  }
}
