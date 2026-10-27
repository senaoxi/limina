import { isPlainRecord } from '#utils/values';

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
  readonly #seen = new WeakMap<object, number>();
  readonly #active = new Set<object>();
  readonly #strings = new Map<string, number>();
  readonly entries: Entry[] = [];

  #object(value: object): number {
    const prior = this.#seen.get(value);
    if (prior !== undefined) return prior;
    if (this.#active.has(value)) throw new Error('Cyclic cache record.');
    this.#active.add(value);
    const entry = this.#entry(value);
    this.#active.delete(value);
    const key = JSON.stringify(entry);
    const id = this.#ids.get(key) ?? this.#append(key, entry);
    this.#seen.set(value, id);
    return id;
  }
  #append(key: string, entry: Entry): number {
    const id = this.entries.length;
    this.entries.push(entry);
    this.#ids.set(key, id);
    return id;
  }
  #string(value: string): number {
    const previous = this.#strings.get(value);
    if (previous !== undefined) return previous;
    const id = this.entries.length;
    this.entries.push(['string', value]);
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
  value(value: unknown): Reference {
    if (value === undefined) return null;
    if (typeof value === 'string') return [this.#string(value)];
    if (value === null || typeof value === 'boolean') return value as Scalar;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'object') throw new Error('Non-JSON cache record.');
    return [this.#object(value!)];
  }
}

export function packRecordTable(value: unknown): RecordTable {
  const writer = new RecordTableWriter();
  const root = writer.value(value);
  return { version: 3, entries: writer.entries, root };
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
  for (const entry of value.entries) {
    const record = readEntry(entry, entries, shared);
    entries.push(
      typeof record === 'string' ? record : ownDecodedRecord(record),
    );
  }
  return readReference(value.root, entries, shared);
}
