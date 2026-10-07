const decoders: Record<string, (node: unknown[]) => unknown> = {
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
  array: (node) => requireEntries(node).map(decodeNode),
  set: (node) => new Set(requireEntries(node).map(decodeNode)),
  object: (node) => Object.fromEntries(decodeEntries(node)),
  map: (node) => new Map(decodeEntries(node)),
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
function decodeEntry(entry: unknown): [string, unknown] {
  if (!Array.isArray(entry)) throw new Error('Invalid data entry.');
  requireArity(entry, 2);
  if (typeof entry[0] !== 'string') throw new Error('Invalid data key.');
  return [entry[0], decodeNode(entry[1])];
}
function decodeEntries(node: unknown[]): [string, unknown][] {
  const entries = requireEntries(node).map(decodeEntry);
  const keys = new Set(entries.map(([key]) => key));
  if (keys.size !== entries.length) throw new Error('Duplicate data key.');
  return entries;
}
export function decodeNode(node: unknown): unknown {
  if (!Array.isArray(node)) throw new Error('Invalid data node.');
  const decode = decoders[String(node[0])];
  if (decode === undefined) throw new Error('Invalid data tag.');
  return decode(node);
}
