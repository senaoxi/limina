import {
  packRecordRoots,
  type RecordEntry,
  type RecordReference,
  type RecordTable,
} from './record-table';

function visitScope(
  root: RecordReference,
  scope: number,
  entries: RecordEntry[],
  owners: Int32Array,
): void {
  const pending = [root];
  while (pending.length > 0) {
    const id = pending.pop();
    if (typeof id !== 'number') continue;
    const owner = owners[id];
    if (owner === scope || owner === -1) continue;
    owners[id] = owner === -2 ? scope : -1;
    const entry = entries[id];
    if (Array.isArray(entry)) {
      for (const child of entry) {
        if (typeof child === 'number') pending.push(child);
      }
    }
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
  if (typeof reference !== 'number') return reference;
  const id = index.ids[reference]!;
  return scope !== -1 && index.owners[reference] === -1 ? -id - 1 : id;
}
function mapEntries(
  entries: RecordEntry[],
  scope: number,
  index: Partition,
): RecordEntry[] {
  for (const entry of entries) {
    if (!Array.isArray(entry)) continue;
    for (let position = 0; position < entry.length; position++) {
      const reference = entry[position];
      if (typeof reference === 'number')
        entry[position] = remap(reference, scope, index);
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
  const all: RecordReference[] = common.map((_entry, id) => id);
  return {
    shared: {
      version: 4,
      entries: [...common, all],
      root: common.length,
    },
    tables: index.locals.map((entries, scope) => ({
      version: 4,
      entries: mapEntries(entries, scope, index),
      root: remap(roots[scope]!, scope, index),
    })),
  };
}
