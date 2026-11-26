import { isPlainRecord } from '#utils/values';

import type { DataNode } from './data-codec';

// Arrays contain references directly. Objects start with a tag followed by
// alternating property names and references; literal numbers are table entries.
export type RecordReference = number | boolean | null;
export type RecordEntry = string | number | (string | RecordReference)[];
export interface RecordTable {
  version: 4;
  entries: RecordEntry[];
  root: RecordReference;
}
const owned = new WeakMap<object, 'table' | 'decoded'>();

/**
Private, immutable decoder data; caller-owned frozen values never qualify.
*/
export function isDecodedRecord(value: unknown): value is object {
  return value !== null && typeof value === 'object' && owned.has(value);
}
export function ownDecodedRecord<T extends object>(value: T): T {
  Object.freeze(value);
  owned.set(value, 'decoded');
  return value;
}

// A table entry and every child came from our finite JSON scalar and reference
// grammar. Other private decoded data can also contain Maps and Sets.
export function isRecordTableData(value: unknown): value is object {
  return (
    value !== null && typeof value === 'object' && owned.get(value) === 'table'
  );
}

class RecordTableWriter {
  readonly #ids = new Map<string, number>();
  readonly #decoded = new WeakMap<object, number>();
  readonly #active = new Set<object>();
  readonly #scalars = new Map<string | number, number>();
  #nextId = 0;
  readonly #store: (entry: RecordEntry) => void;

  constructor(store: (entry: RecordEntry) => void) {
    this.#store = store;
  }

  #object(value: object): number {
    const prior = this.#decoded.get(value);
    if (prior !== undefined) return prior;
    if (this.#active.has(value)) throw new Error('Cyclic cache record.');
    this.#active.add(value);
    const entry = this.#entry(value);
    this.#active.delete(value);
    const key = JSON.stringify(entry);
    const id = this.#ids.get(key) ?? this.#append(key, entry);
    if (isDecodedRecord(value)) this.#decoded.set(value, id);
    // Snapshot copies contain independent mutable objects. Content interning
    // already owns deduplication; retaining every input object's identity here
    // adds an unbounded second index over the much larger expanded snapshot.
    return id;
  }
  #append(key: string, entry: RecordEntry): number {
    const id = this.#nextId++;
    this.#store(entry);
    this.#ids.set(key, id);
    return id;
  }
  #scalar(value: string | number): number {
    const previous = this.#scalars.get(value);
    if (previous !== undefined) return previous;
    const id = this.#nextId++;
    this.#store(value);
    this.#scalars.set(value, id);
    return id;
  }
  #entry(value: object): RecordEntry {
    if (Array.isArray(value)) return value.map((item) => this.value(item));
    if (!isPlainRecord(value)) throw new Error('Non-JSON cache record.');
    // Keep property order: condition maps and raw references are ordered inputs.
    const fields: (string | RecordReference)[] = ['object'];
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) fields.push(key, this.value(item));
    }
    return fields;
  }
  value(value: unknown): RecordReference {
    if (value === undefined || value === null) return null;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') return this.#scalar(value);
    if (typeof value === 'number' && Number.isFinite(value))
      return this.#scalar(value);
    if (typeof value !== 'object') throw new Error('Non-JSON cache record.');
    return this.#object(value);
  }
}

export function packRecordRoots(values: Iterable<unknown>): {
  roots: RecordReference[];
  entries: RecordEntry[];
} {
  const entries: RecordEntry[] = [];
  const writer = new RecordTableWriter((entry) => {
    entries.push(entry);
  });
  const roots = Array.from(values, (value) => writer.value(value));
  return { roots, entries };
}

export function packRecordTable(value: unknown): RecordTable {
  const { roots, entries } = packRecordRoots([value]);
  return { version: 4, entries, root: roots[0]! };
}

function readReference(
  value: unknown,
  entries: readonly unknown[],
  shared: readonly unknown[],
): unknown {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    throw new Error('Invalid cache record reference.');
  const index = value < 0 ? -value - 1 : value;
  const table = value < 0 ? shared : entries;
  if (index >= table.length)
    throw new Error('Missing or cyclic cache record reference.');
  return table[index];
}
function readObject(
  fields: unknown[],
  entries: readonly unknown[],
  shared: readonly unknown[],
): object {
  const keys = new Set<string>();
  const properties: [string, unknown][] = [];
  for (let index = 1; index < fields.length; index += 2) {
    const key = fields[index];
    if (typeof key !== 'string')
      throw new Error('Invalid cache record property.');
    if (keys.has(key)) throw new Error('Duplicate cache record property.');
    keys.add(key);
    properties.push([key, readReference(fields[index + 1], entries, shared)]);
  }
  return Object.fromEntries(properties);
}
function readOwnedEntry(
  value: unknown,
  entries: readonly unknown[],
  shared: readonly unknown[],
): unknown {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!Array.isArray(value))
    throw new Error('Invalid cache record table entry.');
  const record =
    value[0] === 'object'
      ? readObject(value, entries, shared)
      : value.map((item) => readReference(item, entries, shared));
  Object.freeze(record);
  owned.set(record, 'table');
  return record;
}

/** Intern validated query payloads while a context is collecting. The wire
 * value retains its ordered tags, and only private immutable arrays are shared. */
export function createQueryDataPool(): (value: DataNode) => DataNode {
  const values: unknown[] = [];
  const writer = new RecordTableWriter((entry) => {
    const value = readOwnedEntry(entry, values, []);
    values.push(value);
  });
  return (value) => readReference(writer.value(value), values, []) as DataNode;
}

export function unpackRecordTable(
  value: unknown,
  shared: readonly unknown[] = [],
): unknown {
  if (shared.length > 0 && !isRecordTableData(shared))
    throw new Error('Unowned shared cache records.');
  if (
    !isPlainRecord(value) ||
    value.version !== 4 ||
    !Array.isArray(value.entries)
  )
    throw new Error('Invalid cache record table.');
  const entries: unknown[] = [];
  // Backward references make cycles, missing facts and incomplete tables errors.
  for (const entry of value.entries)
    entries.push(readOwnedEntry(entry, entries, shared));
  return readReference(value.root, entries, shared);
}
