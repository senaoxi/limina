import { describe, expect, it } from 'vitest';
import { collectStronglyConnectedComponents } from '../utils/strongly-connected-components';

function collect(nodes: string[], edges: Record<string, string[]>): string[][] {
  return collectStronglyConnectedComponents(nodes, (node) => edges[node] ?? []);
}

describe('collectStronglyConnectedComponents', () => {
  it.each([
    ['an empty graph', [], {}, []],
    ['a disconnected graph', ['a', 'b', 'c'], {}, [['a'], ['b'], ['c']]],
    ['a self-loop', ['a'], { a: ['a'] }, [['a']]],
    ['a mutual cycle', ['a', 'b'], { a: ['b'], b: ['a'] }, [['a', 'b']]],
    [
      'nested cycles',
      ['a', 'b', 'c', 'd'],
      { a: ['b'], b: ['c'], c: ['a', 'd'], d: ['b'] },
      [['a', 'b', 'c', 'd']],
    ],
    [
      'duplicate edges',
      ['a', 'b'],
      { a: ['b', 'b'], b: ['a', 'a'] },
      [['a', 'b']],
    ],
  ])('collects %s', (_label, nodes, edges, expected) => {
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
