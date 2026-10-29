import { compareCodeUnits } from '#utils/collections';
import { isPlainRecord } from '#utils/values';
import { z } from 'zod';
import { isPublishedNativeData } from '../../domain/analysis/native-evidence-freeze';
import type { AnalysisSnapshot, InputDependency } from './contracts';
import { cloneData } from './data-codec';
import { shareValidatedDependency } from './dependency-schema';
import { mapAnalysisRecords } from './record-payload';
import { isDecodedRecord, ownDecodedRecord } from './record-table';

const dependency = z.object({
  inputId: z.string(),
  expectedVersion: z.string(),
});
const listIndex = z.number().int().nonnegative();
const receiptBlock = z.array(listIndex).max(128);
const encoding = z.object({
  version: z.literal(3),
  dependencies: z.array(dependency),
  queryIds: z.array(z.string()),
  lists: z.array(receiptBlock),
});
interface ReceiptTables {
  version: 3;
  dependencies: InputDependency[];
  queryIds: string[];
  lists: number[][];
}
type Transform = (key: string, value: unknown) => unknown;
interface VisitOptions {
  transform: Transform;
  shouldSortKeys?: boolean;
  decoded?: WeakMap<object, object>;
}
function visit(value: unknown, options: VisitOptions): unknown {
  // These JSON proofs are privately owned and recursively immutable. Snapshot
  // isolation needs no second copy; persistence still applies canonical order.
  if (!options.shouldSortKeys && isPublishedNativeData(value)) return value;
  if (!Array.isArray(value) && !isPlainRecord(value)) return value;
  const previous = options.decoded?.get(value);
  if (previous !== undefined) return previous;
  const result = Array.isArray(value)
    ? value.map((item) => visit(item, options))
    : visitRecord(value, options);
  if (
    isDecodedRecord(value) &&
    !options.shouldSortKeys &&
    hasSameEntries(value, result)
  ) {
    options.decoded?.set(value, value);
    return value;
  }
  if (options.decoded !== undefined && isDecodedRecord(value)) {
    ownDecodedRecord(result);
    options.decoded.set(value, result);
  }
  return result;
}
function hasSameEntries(before: object, after: object): boolean {
  const current = after as Record<string, unknown>;
  return Object.entries(before).every(([key, value]) => current[key] === value);
}
function visitRecord(
  value: Record<string, unknown>,
  options: VisitOptions,
): Record<string, unknown> {
  const entries = Object.entries(value);
  if (options.shouldSortKeys)
    entries.sort(([left], [right]) => compareCodeUnits(left, right));
  return Object.fromEntries(
    entries.map(([key, item]) => {
      const transformed = options.transform(key, item);
      return [
        key,
        transformed === item ? visitUnpacked(key, item, options) : transformed,
      ];
    }),
  );
}
function visitUnpacked(
  key: string,
  item: unknown,
  options: VisitOptions,
): unknown {
  // These values are opaque to receipt encoding. Preserve ordered compiler
  // configuration and resolution requests, while omitting non-enumerable
  // compiler AST attachments from their plain data view.
  if (key === 'data') return item;
  const opaque = [
    'options',
    'request',
    'references',
    'projectReferences',
    'identity',
  ];
  // Leave tagged payloads for the data codec: structuredClone would invoke
  // their accessors before the codec can reject live data.
  return visit(
    item,
    opaque.includes(key) ? { transform: (_key, value) => value } : options,
  );
}
function isDependencyList(value: unknown): value is InputDependency[] {
  return Array.isArray(value) && value.every((item) => isDependency(item));
}
function isDependency(value: unknown): value is InputDependency {
  return (
    isPlainRecord(value) &&
    [
      typeof value.inputId === 'string',
      typeof value.expectedVersion === 'string',
    ].every(Boolean)
  );
}
function isQueryList(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}
class ReceiptEncoder {
  readonly #dependencies = new Map<string, Map<string, number>>();
  readonly #queries = new Map<string, number>();
  readonly #lists = new Map<string, number>();
  readonly tables: ReceiptTables = {
    version: 3,
    dependencies: [],
    queryIds: [],
    lists: [],
  };

  #list(ids: number[]): { receiptBlocks: number[] } {
    const receiptBlocks: number[] = [];
    // Bound dictionary entries so near-identical large receipts share their
    // unchanged runs without changing ordering or expected input versions.
    for (let offset = 0; offset < ids.length; offset += 128) {
      const values = ids.slice(offset, offset + 128);
      const key = JSON.stringify(values);
      let id = this.#lists.get(key);
      if (id === undefined) {
        id = this.tables.lists.length;
        this.#lists.set(key, id);
        this.tables.lists.push(values);
      }
      receiptBlocks.push(id);
    }
    return { receiptBlocks };
  }

  #dependency(value: InputDependency): number {
    let versions = this.#dependencies.get(value.inputId);
    if (versions === undefined) {
      versions = new Map();
      this.#dependencies.set(value.inputId, versions);
    }
    const prior = versions.get(value.expectedVersion);
    if (prior !== undefined) return prior;
    const id = this.tables.dependencies.length;
    this.tables.dependencies.push(value);
    versions.set(value.expectedVersion, id);
    return id;
  }
  #query(value: string): number {
    const prior = this.#queries.get(value);
    if (prior !== undefined) return prior;
    const id = this.tables.queryIds.length;
    this.tables.queryIds.push(value);
    this.#queries.set(value, id);
    return id;
  }
  field(key: string, value: unknown): unknown {
    switch (key) {
      case 'dependencies': {
        return this.dependencies(value);
      }
      case 'queryIds': {
        return this.queries(value);
      }
      default: {
        return value;
      }
    }
  }
  dependencies(value: unknown): unknown {
    return isDependencyList(value)
      ? this.#list(value.map((item) => this.#dependency(item)))
      : value;
  }
  queries(value: unknown): unknown {
    return isQueryList(value)
      ? this.#list(value.map((item) => this.#query(item)))
      : value;
  }
}
function encodeRecords(
  records: Record<string, unknown>,
  encodeRecord: (record: unknown) => unknown,
  shouldSortKeys: boolean,
): Record<string, unknown> {
  const encoder = new ReceiptEncoder();
  const encoded = mapAnalysisRecords(records, (record) =>
    encodeRecord(
      visit(record, {
        transform: (key, item) => encoder.field(key, item),
        shouldSortKeys,
      }),
    ),
  );
  return { ...encoded, receiptEncoding: encoder.tables };
}
export function encodeAnalysisRecords(
  records: Record<string, unknown>,
): Record<string, unknown> {
  // Canonical ordering belongs to persisted blocks, never runtime identities.
  return encodeRecords(records, (record) => record, true);
}
export function cloneAnalysisSnapshot(
  snapshot: AnalysisSnapshot,
): AnalysisSnapshot {
  const { header, configModules, ...records } = snapshot;
  // Copy compact tagged values without serializing or compressing them. Receipt
  // parsing owns the tuples; opaque values and runtime identity order survive.
  const encoded = encodeRecords(records, cloneData, false);
  return {
    ...structuredClone({ header, configModules }),
    ...decodeAnalysisRecords(encoded, false),
  } as AnalysisSnapshot;
}
function receiptList(
  value: unknown,
  table: readonly unknown[],
  lists: readonly number[][],
): unknown {
  if (!isPlainRecord(value)) return value;
  const ids = value.receiptBlocks;
  if (!Array.isArray(ids))
    throw new Error('Invalid analysis receipt references.');
  return ids.flatMap((id) =>
    (receipt(id, lists) as number[]).map((index) => receipt(index, table)),
  );
}
function receipt(id: unknown, table: readonly unknown[]): unknown {
  const valid = [
    typeof id === 'number',
    Number.isSafeInteger(id),
    Number(id) >= 0,
    Number(id) < table.length,
  ];
  if (!valid.every(Boolean)) throw new Error('Missing analysis receipt.');
  return table[id as number];
}
function decodeField(
  key: string,
  value: unknown,
  tables: ReceiptTables,
): unknown {
  switch (key) {
    case 'dependencies': {
      return receiptList(value, tables.dependencies, tables.lists);
    }
    case 'queryIds': {
      return receiptList(value, tables.queryIds, tables.lists);
    }
    default: {
      return value;
    }
  }
}
export function decodeAnalysisRecords(
  value: Record<string, unknown>,
  shouldShareValidated = true,
): Record<string, unknown> {
  const tables = encoding.parse(value.receiptEncoding);
  if (shouldShareValidated)
    tables.dependencies = tables.dependencies.map(shareValidatedDependency);
  const records = { ...value };
  delete records.receiptEncoding;
  const shared = new WeakMap<object, object>();
  const decoded = mapAnalysisRecords(records, (record) =>
    visit(record, {
      transform: (key, item) => decodeField(key, item, tables),
      decoded: shouldShareValidated ? shared : undefined,
    }),
  );
  return decoded;
}
