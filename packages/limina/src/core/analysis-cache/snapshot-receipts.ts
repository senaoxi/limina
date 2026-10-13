import { isPlainRecord } from '#utils/values';
import { z } from 'zod';
import type { AnalysisSnapshot, InputDependency } from './contracts';
import { shareValidatedDependency } from './dependency-schema';
import {
  mapAnalysisRecords,
  packAnalysisRecord,
  unpackAnalysisRecord,
} from './record-payload';

const dependency = z.object({
  inputId: z.string(),
  expectedVersion: z.string(),
});
const encoding = z.object({
  version: z.literal(2),
  dependencies: z.array(dependency),
  queryIds: z.array(z.string()),
});
interface ReceiptTables {
  version: 2;
  dependencies: InputDependency[];
  queryIds: string[];
}
type Transform = (key: string, value: unknown) => unknown;
function visit(value: unknown, transform: Transform): unknown {
  if (Array.isArray(value)) return value.map((item) => visit(item, transform));
  return isPlainRecord(value) ? visitRecord(value, transform) : value;
}
function visitRecord(
  value: Record<string, unknown>,
  transform: Transform,
): unknown {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      const transformed = transform(key, item);
      return [
        key,
        transformed === item
          ? visitUnpacked(key, item, transform)
          : transformed,
      ];
    }),
  );
}
function visitUnpacked(
  key: string,
  item: unknown,
  transform: Transform,
): unknown {
  // Encoded semantic/graph data contains no receipt fields.
  return key === 'data' ? item : visit(item, transform);
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
  readonly tables: ReceiptTables = {
    version: 2,
    dependencies: [],
    queryIds: [],
  };

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
      ? { receiptIds: value.map((item) => this.#dependency(item)) }
      : value;
  }
  queries(value: unknown): unknown {
    return isQueryList(value)
      ? { receiptIds: value.map((item) => this.#query(item)) }
      : value;
  }
}
function encodeAnalysisSnapshot(
  snapshot: AnalysisSnapshot,
  format: 'json' | 'data' = 'json',
): Record<string, unknown> {
  const encoder = new ReceiptEncoder();
  const { header, configModules, ...records } = snapshot;
  const encoded = mapAnalysisRecords(records, (record) =>
    packAnalysisRecord(
      visit(record, (key, value) => encoder.field(key, value)),
      format,
    ),
  );
  return {
    header,
    configModules,
    ...encoded,
    receiptEncoding: encoder.tables,
  };
}
export function serializeAnalysisSnapshot(snapshot: AnalysisSnapshot): string {
  return JSON.stringify(encodeAnalysisSnapshot(snapshot));
}
export function cloneAnalysisSnapshot(
  snapshot: AnalysisSnapshot,
): AnalysisSnapshot {
  // Keep isolation without cloning repeated receipt strings once per fact.
  return decodeRecords(
    structuredClone(encodeAnalysisSnapshot(snapshot, 'data')),
  ) as AnalysisSnapshot;
}
function receiptList(value: unknown, table: readonly unknown[]): unknown {
  if (!isPlainRecord(value)) return value;
  const ids = value.receiptIds;
  if (!Array.isArray(ids))
    throw new Error('Invalid analysis receipt references.');
  return ids.map((id) => receipt(id, table));
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
      return receiptList(value, tables.dependencies);
    }
    case 'queryIds': {
      return receiptList(value, tables.queryIds);
    }
    default: {
      return value;
    }
  }
}
function decodeRecords(
  value: Record<string, unknown>,
  shouldShareValidated?: boolean,
): unknown {
  if (value.receiptEncoding === undefined) return value;
  const tables = encoding.parse(value.receiptEncoding);
  if (shouldShareValidated)
    tables.dependencies = tables.dependencies.map(shareValidatedDependency);
  const { header, configModules, ...records } = value;
  delete records.receiptEncoding;
  const decoded = mapAnalysisRecords(records, (record) =>
    visit(unpackAnalysisRecord(record), (key, item) =>
      decodeField(key, item, tables),
    ),
  );
  return { header, configModules, ...decoded };
}
export function decodeAnalysisSnapshotReceipts(
  value: unknown,
  shouldShareValidated?: boolean,
): unknown {
  try {
    return isPlainRecord(value)
      ? decodeRecords(value, shouldShareValidated)
      : value;
  } catch {
    return undefined;
  }
}
