import {
  packRecordRoots,
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
  const pending = [root];
  while (pending.length > 0) {
    const reference = pending.pop()!;
    if (!Array.isArray(reference)) continue;
    const id = reference[0];
    const owner = owners[id];
    if (owner === scope || owner === -1) continue;
    owners[id] = owner === -2 ? scope : -1;
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
  references?: Map<number, [number]>,
): RecordReference {
  if (!Array.isArray(reference)) return reference;
  const id = index.ids[reference[0]]!;
  const target =
    scope !== -1 && index.owners[reference[0]] === -1 ? -id - 1 : id;
  const prior = references?.get(target);
  if (prior !== undefined) return prior;
  const result: [number] = [target];
  references?.set(target, result);
  return result;
}
function mapEntries(
  entries: RecordEntry[],
  scope: number,
  index: Partition,
): RecordEntry[] {
  // Preserve reference interning when partitioning the global table. One
  // destination needs one tuple per index, not one allocation per occurrence.
  const references = new Map<number, [number]>();
  for (const entry of entries) {
    if (entry[0] === 'array') {
      const items = entry[1];
      for (let position = 0; position < items.length; position++)
        items[position] = remap(items[position]!, scope, index, references);
    } else if (entry[0] === 'object') {
      const fields = entry[1];
      for (const pair of fields)
        pair[1] = remap(pair[1], scope, index, references);
    }
  }
  return entries;
}

/**
Cross-scope facts share one immutable pool. A shared node's entire closure is
shared; local blocks can only refer backward or into this qualified pool.
Projection blocks use a separate table and never enlarge the fact read closure.
*/
export function packSharedRecordTables(values: Iterable<unknown>): {
  shared: RecordTable;
  tables: RecordTable[];
} {
  const { entries, roots } = packRecordRoots(values);
  const index = partition(entries, roots);
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
