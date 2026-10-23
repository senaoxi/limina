import { decodeNode } from './data-decoder';

/*
Plain data only. Tags preserve undefined and ordered Map/Set entries.
*/
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
export function decodeData(node: unknown): unknown {
  return decodeNode(node, true);
}

/**
Validate the same wire grammar without retaining a discarded graph copy.
*/
export function validateData(node: unknown): void {
  decodeNode(node, false);
}
