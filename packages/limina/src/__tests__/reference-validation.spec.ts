import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateRestoredReferences } from '../core/build-graph/reference-validation';
import type { DependencyAnalysisResult } from '../core/build-graph/types';
import { createFixturePathResolver } from './helpers/path';

const file = createFixturePathResolver(
  path.resolve('reference-validation-fixture'),
);

function candidate(references: Record<string, string[]>) {
  const dependencyAnalysis: DependencyAnalysisResult = {
    complete: true,
    facts: [],
    diagnostics: [],
    referenceValidation: { state: 'admitted', diagnostics: [] },
  };
  return {
    dependencyAnalysis,
    generatedFiles: new Map(
      Object.entries(references).map(([from, to]) => [
        file(from),
        JSON.stringify({
          references: to.map((target) => ({ path: `./${target}` })),
        }),
      ]),
    ),
    sourceToDts: new Map([
      [
        'tsc',
        new Map([
          ['source-a', file('a.json')],
          ['source-b', file('b.json')],
        ]),
      ],
    ]),
    sourceToBuild: new Map([
      [
        'tsc',
        new Map([
          [
            'solution',
            { kind: 'solution' as const, path: file('solution.json') },
          ],
        ]),
      ],
    ]),
    configToOutputBuild: new Map([
      [
        'tsc',
        new Map([
          ['source-a', { kind: 'project' as const, path: file('output.json') }],
        ]),
      ],
    ]),
    checkerEntries: new Map([['tsc', file('entry.json')]]),
  };
}

function dag(): Record<string, string[]> {
  return {
    'a.json': ['b.json'],
    'b.json': [],
    'solution.json': ['a.json', 'b.json'],
    'entry.json': ['solution.json'],
    'output.json': ['b.json'],
  };
}

describe('final serialized project reference admission', () => {
  it.each(['a.json', 'solution.json', 'entry.json', 'output.json'] as const)(
    'rejects a restored cycle involving %s despite claimed admission',
    (target) => {
      const references = dag();
      references['b.json'] = [target];
      const graph = candidate(references);
      validateRestoredReferences(graph);
      expect(graph.dependencyAnalysis.referenceValidation?.state).toBe(
        'denied',
      );
      expect(
        graph.dependencyAnalysis.referenceValidation?.diagnostics.join('\n'),
      ).toContain(file(target));
    },
  );
  it('rejects a self reference and reports the actual edge', () => {
    const references = dag();
    references['b.json'] = ['b.json'];
    const graph = candidate(references);
    validateRestoredReferences(graph);
    expect(graph.dependencyAnalysis.referenceValidation?.state).toBe('denied');
    expect(
      graph.dependencyAnalysis.referenceValidation?.diagnostics.join('\n'),
    ).toContain(`${file('b.json')} -> ${file('b.json')}`);
  });
  it('admits a shared DAG while excluding scheduling relations', () => {
    const graph = {
      ...candidate(dag()),
      dependencyEdges: [
        {
          kind: 'framework-schedule',
          fromConfigPath: file('a.json'),
          toConfigPath: file('b.json'),
        },
        {
          kind: 'framework-schedule',
          fromConfigPath: file('b.json'),
          toConfigPath: file('a.json'),
        },
      ],
    };
    validateRestoredReferences(graph);
    expect(graph.dependencyAnalysis.referenceValidation).toEqual({
      state: 'admitted',
      diagnostics: [],
    });
  });
  it('cannot admit a missing serialized target', () => {
    const graph = candidate(dag());
    graph.generatedFiles.delete(file('b.json'));
    validateRestoredReferences(graph);
    expect(graph.dependencyAnalysis.referenceValidation?.state).toBe(
      'unavailable',
    );
  });
});
