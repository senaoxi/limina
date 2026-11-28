export type ScalarDataNode =
  | ['undefined']
  | ['null']
  | ['string', string]
  | ['boolean', boolean]
  | ['number', number];

export function scalarNode(value: unknown): ScalarDataNode | undefined {
  // Avoid constructing lookup tables and closures for every visited value.
  if (value === undefined) return ['undefined'];
  return value === null ? ['null'] : typedScalar(value);
}
function typedScalar(value: unknown): ScalarDataNode | undefined {
  if (typeof value === 'string') return ['string', value];
  return typeof value === 'boolean' ? ['boolean', value] : numberNode(value);
}
function numberNode(value: unknown): ScalarDataNode | undefined {
  if (typeof value !== 'number') return undefined;
  if (!Number.isFinite(value)) throw new Error('Non-finite data.');
  return ['number', value];
}
