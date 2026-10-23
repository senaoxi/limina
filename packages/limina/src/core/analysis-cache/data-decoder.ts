type Decoder = (node: unknown[], shouldDecode: boolean) => unknown;
const decoders: Record<string, Decoder> = {
  undefined: (node) => {
    requireArity(node, 1);
  },
  null: (node) => {
    requireArity(node, 1);
    return null;
  },
  string: (node) => requireScalar(node, 'string'),
  boolean: (node) => requireScalar(node, 'boolean'),
  number: (node) => {
    const value = requireScalar(node, 'number');
    if (!Number.isFinite(value)) throw new Error('Non-finite data.');
    return value;
  },
  array: decodeSequence,
  set: (node, shouldDecode) => {
    const entries = decodeSequence(node, shouldDecode);
    return shouldDecode ? new Set(entries) : undefined;
  },
  object: (node, shouldDecode) => {
    const entries = decodeEntries(node, shouldDecode);
    return shouldDecode ? Object.fromEntries(entries) : undefined;
  },
  map: (node, shouldDecode) => {
    const entries = decodeEntries(node, shouldDecode);
    return shouldDecode ? new Map(entries) : undefined;
  },
};
function requireArity(node: unknown[], arity: number): void {
  if (node.length !== arity) throw new Error('Invalid data arity.');
}
function requireScalar(node: unknown[], type: string): unknown {
  requireArity(node, 2);
  if (typeof node[1] !== type) throw new Error('Invalid scalar type.');
  return node[1];
}
function requireEntries(node: unknown[]): unknown[] {
  requireArity(node, 2);
  if (!Array.isArray(node[1])) throw new Error('Invalid data entries.');
  return node[1];
}
function requireEntry(entry: unknown): [string, unknown] {
  if (!Array.isArray(entry)) throw new Error('Invalid data entry.');
  requireArity(entry, 2);
  if (typeof entry[0] !== 'string') throw new Error('Invalid data key.');
  return entry as [string, unknown];
}
function decodeSequence(node: unknown[], shouldDecode: boolean): unknown[] {
  const entries: unknown[] = [];
  for (const entry of requireEntries(node)) {
    const value = decodeNode(entry, shouldDecode);
    if (shouldDecode) entries.push(value);
  }
  return entries;
}
function decodeEntries(
  node: unknown[],
  shouldDecode: boolean,
): [string, unknown][] {
  const entries: [string, unknown][] = [];
  const keys = new Set<string>();
  for (const entry of requireEntries(node)) {
    const [key, child] = requireUniqueEntry(entry, keys);
    const value = decodeNode(child, shouldDecode);
    if (shouldDecode) entries.push([key, value]);
  }
  return entries;
}
function requireUniqueEntry(
  entry: unknown,
  keys: Set<string>,
): [string, unknown] {
  const [key, child] = requireEntry(entry);
  if (keys.has(key)) throw new Error('Duplicate data key.');
  keys.add(key);
  return [key, child];
}
export function decodeNode(node: unknown, shouldDecode: boolean): unknown {
  if (!Array.isArray(node)) throw new Error('Invalid data node.');
  const decode = decoders[String(node[0])];
  if (decode === undefined) throw new Error('Invalid data tag.');
  return decode(node, shouldDecode);
}
