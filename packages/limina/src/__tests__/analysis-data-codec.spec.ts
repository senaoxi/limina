import { expect, it } from 'vitest';
import {
  type DataNode,
  decodeData,
  encodeData,
  validateData,
} from '../core/analysis-cache/data-codec';

it.each<{ name: string; value: unknown; encoded: DataNode }>([
  { name: 'undefined', value: undefined, encoded: ['undefined'] },
  { name: 'null', value: null, encoded: ['null'] },
  { name: 'empty string', value: '', encoded: ['string', ''] },
  { name: 'string', value: '中文', encoded: ['string', '中文'] },
  { name: 'false', value: false, encoded: ['boolean', false] },
  { name: 'true', value: true, encoded: ['boolean', true] },
  { name: 'zero', value: 0, encoded: ['number', 0] },
  { name: 'negative zero', value: -0, encoded: ['number', -0] },
  {
    name: 'largest finite number',
    value: Number.MAX_VALUE,
    encoded: ['number', Number.MAX_VALUE],
  },
  {
    name: 'smallest positive number',
    value: Number.MIN_VALUE,
    encoded: ['number', Number.MIN_VALUE],
  },
])('preserves $name and owns each encoded scalar', ({ value, encoded }) => {
  const result = encodeData(value);
  expect(result).toStrictEqual(encoded);
  expect(decodeData(encoded)).toBe(value);
  expect(() => validateData(encoded)).not.toThrow();
  result.pop();
  expect(encodeData(value)).toStrictEqual(encoded);
});

it.each([NaN, Infinity, -Infinity])('rejects non-finite data %s', (value) => {
  expect(() => encodeData(value)).toThrow('Non-finite data.');
});

it.each([
  { name: 'function', value: () => 1 },
  { name: 'symbol', value: Symbol('runtime identity') },
  { name: 'bigint', value: 1n },
])('rejects unsupported $name data', ({ value }) => {
  expect(() => encodeData(value)).toThrow('Executable data.');
});

it('validates nested containers while decoding retains their kinds and order', () => {
  const value = new Map([
    ['set', new Set<unknown>([undefined, null, { values: [false, 0, ''] }])],
    ['empty', new Set()],
  ]);
  const encoded = encodeData(value);
  expect(() => validateData(encoded)).not.toThrow();
  expect(decodeData(encoded)).toStrictEqual(value);
});

it.each([
  { name: 'unknown tag', node: ['unknown'] },
  { name: 'wrong arity', node: ['null', 1] },
  { name: 'wrong scalar', node: ['number', '1'] },
  { name: 'non-finite child', node: ['set', [['number', Infinity]]] },
  { name: 'non-array entries', node: ['array', {}] },
  { name: 'non-node child', node: ['array', [null]] },
  { name: 'non-string key', node: ['map', [[1, ['null']]]] },
  { name: 'wrong entry arity', node: ['object', [['a', ['null'], 1]]] },
  {
    name: 'duplicate map key',
    node: [
      'map',
      [
        ['a', ['null']],
        ['a', ['string', 'different']],
      ],
    ],
  },
  {
    name: 'nested duplicate object key',
    node: [
      'array',
      [
        [
          'object',
          [
            ['a', ['null']],
            ['a', ['null']],
          ],
        ],
      ],
    ],
  },
])('rejects $name in both validation and decoding', ({ node }) => {
  expect(() => validateData(node)).toThrow();
  expect(() => decodeData(node)).toThrow();
});
