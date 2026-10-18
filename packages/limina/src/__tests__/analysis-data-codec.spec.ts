import { expect, it } from 'vitest';
import {
  type DataNode,
  decodeData,
  encodeData,
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
