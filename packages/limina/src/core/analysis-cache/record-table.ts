import { isPlainRecord } from '#utils/values';

import type { DataNode } from './data-codec';

type Scalar = string | number | boolean | null;
export type RecordReference = Scalar | [number];
type Reference = RecordReference;
export type RecordEntry =
  | ['string', string]
  | ['array', Reference[]]
  | ['object', [string, Reference][]];
type Entry = RecordEntry;
export interface RecordTable {
  version: 3;
  entries: RecordEntry[];
  root: Reference;
}
const owned = new WeakSet<object>();

/**
Private, immutable decoder data; caller-owned frozen values never qualify.
*/
export function isDecodedRecord(value: unknown): value is object {
  return value !== null && typeof value === 'object' && owned.has(value);
}
export function ownDecodedRecord<T extends object>(value: T): T {
  Object.freeze(value);
  owned.add(value);
  return value;
}

class RecordTableWriter {
  readonly #ids = new Map<string, number>();
  readonly #decoded = new WeakMap<object, number>();
  readonly #active = new Set<object>();
  readonly #strings = new Map<string, number>();
  readonly #references: [number][] = [];
  #nextId = 0;
  readonly #store: (entry: Entry) => void;

  constructor(store: (entry: Entry) => void) {
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
  #append(key: string, entry: Entry): number {
    const id = this.#nextId++;
    this.#store(entry);
    this.#ids.set(key, id);
    return id;
  }
  #string(value: string): number {
    const previous = this.#strings.get(value);
    if (previous !== undefined) return previous;
    const id = this.#nextId++;
    this.#store(['string', value]);
    this.#strings.set(value, id);
    return id;
  }
  #entry(value: object): Entry {
    if (Array.isArray(value))
      return ['array', value.map((item) => this.value(item))];
    if (!isPlainRecord(value)) throw new Error('Non-JSON cache record.');
    // Keep property order: condition maps and raw references are ordered inputs.
    return [
      'object',
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, this.value(item)]),
    ];
  }
  #reference(id: number): [number] {
    // Table references are immutable while packing. Repeated scalar and object
    // references need one tuple per table entry, not one allocation per use.
    return (this.#references[id] ??= [id]);
  }
  value(value: unknown): Reference {
    if (value === undefined) return null;
    if (typeof value === 'string') return this.#reference(this.#string(value));
    if (value === null || typeof value === 'boolean') return value as Scalar;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'object') throw new Error('Non-JSON cache record.');
    return this.#reference(this.#object(value!));
  }
}

export function packRecordRoots(values: Iterable<unknown>): {
  roots: RecordReference[];
  entries: RecordEntry[];
} {
  const entries: Entry[] = [];
  const writer = new RecordTableWriter((entry) => {
    entries.push(entry);
  });
  const roots = Array.from(values, (value) => writer.value(value));
  return { roots, entries };
}

export function packRecordTable(value: unknown): RecordTable {
  const { roots, entries } = packRecordRoots([value]);
  return { version: 3, entries, root: roots[0]! };
}

function readReference(
  value: unknown,
  entries: readonly unknown[],
  shared: readonly unknown[],
): unknown {
  if (value === null || ['string', 'boolean'].includes(typeof value))
    return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (
    !Array.isArray(value) ||
    value.length !== 1 ||
    !Number.isSafeInteger(value[0])
  )
    throw new Error('Missing or cyclic cache record reference.');
  const index = value[0] < 0 ? -value[0] - 1 : value[0];
  const table = value[0] < 0 ? shared : entries;
  if (index >= table.length)
    throw new Error('Missing or cyclic cache record reference.');
  return table[index];
}
function readObject(
  value: unknown[],
  entries: readonly unknown[],
  shared: readonly unknown[],
): object {
  const keys = new Set<string>();
  return Object.fromEntries(
    value.map((entry) => {
      if (
        !Array.isArray(entry) ||
        entry.length !== 2 ||
        typeof entry[0] !== 'string'
      )
        throw new Error('Invalid cache record property.');
      if (keys.has(entry[0]))
        throw new Error('Duplicate cache record property.');
      keys.add(entry[0]);
      return [entry[0], readReference(entry[1], entries, shared)];
    }),
  );
}
function readEntry(
  value: unknown,
  entries: readonly unknown[],
  shared: readonly unknown[],
): object | string {
  if (!Array.isArray(value) || value.length !== 2)
    throw new Error('Invalid cache record table entry.');
  if (value[0] === 'string' && typeof value[1] === 'string') return value[1];
  if (!Array.isArray(value[1]))
    throw new Error('Invalid cache record table entry.');
  if (value[0] === 'array')
    return value[1].map((item) => readReference(item, entries, shared));
  if (value[0] === 'object') return readObject(value[1], entries, shared);
  throw new Error('Invalid cache record table kind.');
}
function readOwnedEntry(
  entry: unknown,
  entries: readonly unknown[],
  shared: readonly unknown[],
): unknown {
  const value = readEntry(entry, entries, shared);
  return typeof value === 'string' ? value : ownDecodedRecord(value);
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
  if (shared.length > 0 && !isDecodedRecord(shared))
    throw new Error('Unowned shared cache records.');
  if (
    !isPlainRecord(value) ||
    value.version !== 3 ||
    !Array.isArray(value.entries)
  )
    throw new Error('Invalid cache record table.');
  const entries: unknown[] = [];
  // Backward references make cycles, missing facts and incomplete tables errors.
  for (const entry of value.entries)
    entries.push(readOwnedEntry(entry, entries, shared));
  return readReference(value.root, entries, shared);
}
