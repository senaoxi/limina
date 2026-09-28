import { describe, expect, it } from 'vitest';
import { collectStronglyConnectedComponents } from '../utils/strongly-connected-components';

function collect(nodes: string[], edges: Record<string, string[]>): string[][] {
  return collectStronglyConnectedComponents(nodes, (node) => edges[node] ?? []);
}

interface GraphCase {
  edges: Record<string, string[]>;
  expected: string[][];
  label: string;
  nodes: string[];
}

const graphCases: GraphCase[] = [
  { edges: {}, expected: [], label: 'an empty graph', nodes: [] },
  {
    edges: {},
    expected: [['a'], ['b'], ['c']],
    label: 'a disconnected graph',
    nodes: ['a', 'b', 'c'],
  },
  {
    edges: { a: ['a'] },
    expected: [['a']],
    label: 'a self-loop',
    nodes: ['a'],
  },
  {
    edges: { a: ['b'], b: ['a'] },
    expected: [['a', 'b']],
    label: 'a mutual cycle',
    nodes: ['a', 'b'],
  },
  {
    edges: { a: ['b'], b: ['c'], c: ['a', 'd'], d: ['b'] },
    expected: [['a', 'b', 'c', 'd']],
    label: 'nested cycles',
    nodes: ['a', 'b', 'c', 'd'],
  },
  {
    edges: { a: ['b', 'b'], b: ['a', 'a'] },
    expected: [['a', 'b']],
    label: 'duplicate edges',
    nodes: ['a', 'b'],
  },
];

describe('collectStronglyConnectedComponents', () => {
  it.each(graphCases)('collects $label', ({ edges, expected, nodes }) => {
    expect(collect(nodes, edges)).toEqual(expected);
  });

  it('orders component members and components by input rank', () => {
    expect(
      collect(['c', 'a', 'd', 'b'], {
        a: ['c'],
        b: ['b'],
        c: ['a'],
      }),
    ).toEqual([['c', 'a'], ['d'], ['b']]);
  });

  it('rejects edges to nodes outside the input union', () => {
    expect(() => collect(['a'], { a: ['missing'] })).toThrow(
      'Strongly connected components received an edge to an unknown node.',
    );
  });

  it('rejects duplicate input nodes', () => {
    expect(() => collect(['a', 'a'], {})).toThrow(
      'Strongly connected components require unique input nodes.',
    );
  });
});
