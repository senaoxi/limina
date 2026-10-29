/*
Plain data only. Tags preserve undefined and ordered Map/Set entries.
*/
import { isPublishedNativeData } from '../../domain/analysis/native-evidence-freeze';
import { isDecodedRecord, ownDecodedRecord } from './record-table';

export type DataNode =
  | ['undefined']
  | ['null']
  | ['string', string]
  | ['boolean', boolean]
  | ['number', number]
  | ['array', DataNode[]]
  | ['set', DataNode[]]
  | ['object', [string, DataNode][]]
  | ['map', [string, DataNode][]];

interface DecodeState {
  retain: boolean;
  shouldShare: boolean;
  values: WeakMap<object, unknown>;
}
type Decoder = (node: unknown[], state: DecodeState) => unknown;
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
  set: (node, state) => {
    const entries = decodeSequence(node, state);
    return state.retain ? new Set(entries) : undefined;
  },
  object: (node, state) => {
    const entries = decodeEntries(node, state);
    return state.retain ? Object.fromEntries(entries) : undefined;
  },
  map: (node, state) => {
    const entries = decodeEntries(node, state);
    return state.retain ? new Map(entries) : undefined;
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
function decodeSequence(node: unknown[], state: DecodeState): unknown[] {
  const entries: unknown[] = [];
  for (const entry of requireEntries(node)) {
    const value = decodeNode(entry, state);
    if (state.retain) entries.push(value);
  }
  return entries;
}
function decodeEntries(
  node: unknown[],
  state: DecodeState,
): [string, unknown][] {
  const entries: [string, unknown][] = [];
  const keys = new Set<string>();
  for (const entry of requireEntries(node)) {
    const [key, child] = requireUniqueEntry(entry, keys);
    const value = decodeNode(child, state);
    if (state.retain) entries.push([key, value]);
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
function decodeNode(node: unknown, state: DecodeState): unknown {
  if (!Array.isArray(node)) throw new Error('Invalid data node.');
  const isShared =
    isDecodedRecord(node) && (!state.retain || state.shouldShare);
  if (isShared && state.values.has(node)) return state.values.get(node);
  const decode = decoders[String(node[0])];
  if (decode === undefined) throw new Error('Invalid data tag.');
  const value = decode(node, state);
  if (isShared) {
    if (value !== null && typeof value === 'object') ownDecodedRecord(value);
    state.values.set(node, value);
  }
  return value;
}

type Encoder = (value: object, stack: Set<object>) => DataNode;
const objectEncoders: { accepts(value: object): boolean; encode: Encoder }[] = [
  {
    accepts: Array.isArray,
    encode: (value, stack) => [
      'array',
      (value as unknown[]).map((item) => encodeData(item, stack)),
    ],
  },
  {
    accepts: (value) => value instanceof Set,
    encode: (value, stack) => [
      'set',
      [...(value as Set<unknown>)].map((item) => encodeData(item, stack)),
    ],
  },
  {
    accepts: (value) => value instanceof Map,
    encode: (value, stack) => [
      'map',
      [...(value as Map<unknown, unknown>)].map(([key, item]) => [
        requireStringKey(key),
        encodeData(item, stack),
      ]),
    ],
  },
  {
    accepts: (value) =>
      [Object.prototype, null].includes(Object.getPrototypeOf(value)),
    encode: encodeObject,
  },
];
function requireStringKey(key: unknown): string {
  if (typeof key !== 'string') throw new Error('Invalid data key.');
  return key;
}
function encodeObject(value: object, stack: Set<object>): DataNode {
  const entries = Object.entries(Object.getOwnPropertyDescriptors(value)).map(
    ([key, property]): [string, DataNode] => {
      if (!('value' in property)) throw new Error('Live data accessor.');
      return [key, encodeData(property.value, stack)];
    },
  );
  return ['object', entries];
}
function scalarNode(value: unknown): DataNode | undefined {
  // Avoid constructing lookup tables and closures for every visited value.
  if (value === undefined) return ['undefined'];
  return value === null ? ['null'] : typedScalar(value);
}
function typedScalar(value: unknown): DataNode | undefined {
  if (typeof value === 'string') return ['string', value];
  return typeof value === 'boolean' ? ['boolean', value] : numberNode(value);
}
function numberNode(value: unknown): DataNode | undefined {
  if (typeof value !== 'number') return undefined;
  if (!Number.isFinite(value)) throw new Error('Non-finite data.');
  return ['number', value];
}
function requireObject(value: unknown, stack: Set<object>): object {
  if (typeof value !== 'object') throw new Error('Executable data.');
  const object = value as object;
  if (
    [stack.has(object), Object.getOwnPropertySymbols(object).length > 0].some(
      Boolean,
    )
  )
    throw new Error('Cyclic or runtime data identity.');
  return object;
}
export function encodeData(
  value: unknown,
  stack: Set<object> = new Set(),
): DataNode {
  const scalar = scalarNode(value);
  return scalar === undefined ? encodeContainer(value, stack) : scalar;
}
function encodeContainer(value: unknown, stack: Set<object>): DataNode {
  const object = requireObject(value, stack);
  const encoder = objectEncoders.find((item) => item.accepts(object));
  if (encoder === undefined) throw new Error('Opaque data object.');
  stack.add(object);
  try {
    return encoder.encode(object, stack);
  } finally {
    stack.delete(object);
  }
}
export function decodeData(node: unknown, shouldShare = false): unknown {
  return decodeNode(node, { retain: true, shouldShare, values: new WeakMap() });
}

/** Copy the same accepted plain-data grammar without allocating a second
 * tagged tree. Like encode/decode, repeated mutable values get independent
 * copies and accessors are rejected without being invoked. */
export function cloneData(
  value: unknown,
  stack: Set<object> = new Set(),
): unknown {
  if (isPublishedNativeData(value)) return value;
  const scalar = scalarNode(value);
  if (scalar !== undefined) return value;
  const object = requireObject(value, stack);
  stack.add(object);
  try {
    if (Array.isArray(object))
      return object.map((item) => cloneData(item, stack));
    if (object instanceof Set)
      return new Set([...object].map((item) => cloneData(item, stack)));
    if (object instanceof Map)
      return new Map(
        [...object].map(([key, item]) => [
          requireStringKey(key),
          cloneData(item, stack),
        ]),
      );
    if (![Object.prototype, null].includes(Object.getPrototypeOf(object)))
      throw new Error('Opaque data object.');
    return Object.fromEntries(
      Object.entries(Object.getOwnPropertyDescriptors(object)).map(
        ([key, property]) => {
          if (!('value' in property)) throw new Error('Live data accessor.');
          return [key, cloneData(property.value, stack)];
        },
      ),
    );
  } finally {
    stack.delete(object);
  }
}

/**
Validate the same wire grammar without retaining a discarded graph copy.
*/
export function validateData(node: unknown): void {
  decodeNode(node, {
    retain: false,
    shouldShare: false,
    values: new WeakMap(),
  });
}
