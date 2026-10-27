import {
  packRecordTable,
  type RecordEntry,
  type RecordReference,
  type RecordTable,
} from './record-table';

function references(entry: RecordEntry): RecordReference[] {
  if (entry[0] === 'string') return [];
  return entry[0] === 'array' ? entry[1] : entry[1].map((pair) => pair[1]);
}

function visitScope(
  root: RecordReference,
  scope: number,
  entries: RecordEntry[],
  owners: Int32Array,
): void {
  const seen = new Set<number>();
  const pending = [root];
  while (pending.length > 0) {
    const reference = pending.pop()!;
    if (!Array.isArray(reference) || seen.has(reference[0])) continue;
    const id = reference[0];
    seen.add(id);
    owners[id] = owners[id] === -2 || owners[id] === scope ? scope : -1;
    const children = references(entries[id]!);
    for (const child of children) pending.push(child);
  }
}

interface Partition {
  owners: Int32Array;
  ids: Int32Array;
  common: RecordEntry[];
  locals: RecordEntry[][];
}
function partition(
  entries: RecordEntry[],
  roots: RecordReference[],
): Partition {
  const owners = new Int32Array(entries.length).fill(-2);
  for (const [scope, root] of roots.entries())
    visitScope(root, scope, entries, owners);
  const ids = new Int32Array(entries.length).fill(-1);
  const common: RecordEntry[] = [];
  const locals: RecordEntry[][] = roots.map(() => []);
  for (const [id, entry] of entries.entries()) {
    if (owners[id] === -2) continue;
    const target = owners[id] === -1 ? common : locals[owners[id]!]!;
    ids[id] = target.length;
    target.push(entry);
  }
  return { owners, ids, common, locals };
}
function remap(
  reference: RecordReference,
  scope: number,
  index: Partition,
): RecordReference {
  if (!Array.isArray(reference)) return reference;
  const id = index.ids[reference[0]]!;
  return [scope !== -1 && index.owners[reference[0]] === -1 ? -id - 1 : id];
}
function mapEntries(
  entries: RecordEntry[],
  scope: number,
  index: Partition,
): RecordEntry[] {
  return entries.map((entry): RecordEntry => {
    if (entry[0] === 'string') return entry;
    return entry[0] === 'array'
      ? ['array', entry[1].map((reference) => remap(reference, scope, index))]
      : [
          'object',
          entry[1].map(([key, reference]) => [
            key,
            remap(reference, scope, index),
          ]),
        ];
  });
}

/**
Cross-scope facts share one immutable pool. A shared node's entire closure is
shared; local blocks can only refer backward or into this qualified pool.
Projection blocks use a separate table and never enlarge the fact read closure.
*/
export function packSharedRecordTables(values: unknown[]): {
  shared: RecordTable;
  tables: RecordTable[];
} {
  const table = packRecordTable(values);
  const root = table.entries[(table.root as [number])[0]]!;
  if (root[0] !== 'array') throw new Error('Invalid record table roots.');
  const roots = root[1];
  const index = partition(table.entries, roots);
  const common = mapEntries(index.common, -1, index);
  const all: RecordReference[] = common.map((_entry, id) => [id]);
  return {
    shared: {
      version: 3,
      entries: [...common, ['array', all]],
      root: [common.length],
    },
    tables: index.locals.map((entries, scope) => ({
      version: 3,
      entries: mapEntries(entries, scope, index),
      root: remap(roots[scope]!, scope, index),
    })),
  };
}
