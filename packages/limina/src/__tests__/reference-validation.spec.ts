import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CheckerOwnershipPlan } from '../core/build-graph/checker-ownership-types';
import { createGeneratedGraphStructuredError } from '../core/build-graph/problems';
import { validateRestoredReferences } from '../core/build-graph/reference-validation';
import type {
  DependencyAnalysisResult,
  GovernedSourceUnit,
} from '../core/build-graph/types';
import { withFixtureGovernanceRoot } from './helpers/governance-root';
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
    ownershipPlan: {
      dependencyFacts: [],
      sourceConfigPathsByEntry: new Map(),
      solutions: new Map(),
      typeConfigs: new Map(
        ['a', 'b'].map((name) => [
          `source-${name}`,
          {
            configPath: `source-${name}`,
            evidence: [],
            kind: 'type',
            localOwner: { kind: 'resolved', checker: 'tsc' },
            finalOwner: 'tsc',
            semanticAuthority: {
              kind: 'locked',
              family: 'typescript',
              source: 'explicit',
            },
          },
        ]),
      ),
    } satisfies CheckerOwnershipPlan,
    governedSources: new Map([
      [
        'tsc',
        new Map(
          ['a', 'b'].map((name) => [
            `source-${name}`,
            {
              configPath: `source-${name}`,
              primaryCheckerName: 'tsc',
              buildProjection: {
                kind: 'declaration-project',
                dtsConfigPath: file(`${name}.json`),
              },
              context: { checkerPresets: ['tsc'], extensions: ['.ts'] },
              ownedFileNames: [],
              declarationFileNames: [],
              declarationReferences: new Set<string>(),
              frameworkCapabilities: [],
              packageRootDir: file('.'),
              semanticAuthority: {
                kind: 'locked',
                family: 'typescript',
                source: 'explicit',
              },
            } satisfies GovernedSourceUnit,
          ]),
        ),
      ],
    ]),
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
  it.each(['tsc', 'vue-tsc'])(
    'preserves restored cycle attribution when another member uses %s',
    (checkerName) => {
      const references = dag();
      references['b.json'] = ['a.json'];
      const graph = candidate(references);
      graph.sourceToDts.get('tsc')!.delete('source-b');
      const entries = graph.sourceToDts.get(checkerName) ?? new Map();
      entries.set('source-b', file('b.json'));
      graph.sourceToDts.set(checkerName, entries);
      validateRestoredReferences(graph);
      const error = createGeneratedGraphStructuredError({
        config: withFixtureGovernanceRoot({
          rootDir: file('.'),
          configPath: file('limina.config.mts'),
        }),
        fallback: 'Failed to prepare generated tsconfig graph.',
        problems: graph.dependencyAnalysis.referenceValidation!.diagnostics,
      });
      expect(error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            checkerName: checkerName === 'tsc' ? 'tsc' : undefined,
            code: 'LIMINA_GRAPH_REFERENCE_CYCLE',
            filePath: 'a.json',
            task: 'graph:check',
          }),
        ]),
      );
    },
  );
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
  it('rejects colliding generated identities before indexing overwrites either source', () => {
    const graph = candidate(dag());
    graph.sourceToDts.get('tsc')!.set('source-b', file('a.json'));
    validateRestoredReferences(graph);
    expect(graph.dependencyAnalysis.referenceValidation).toMatchObject({
      state: 'denied',
      diagnostics: [
        expect.stringContaining('Conflicting generated config identity'),
      ],
    });
  });
  it('rejects an output path colliding with the same source declaration identity', () => {
    const graph = candidate(dag());
    graph.configToOutputBuild
      .get('tsc')!
      .set('source-a', { kind: 'project', path: file('a.json') });
    validateRestoredReferences(graph);
    expect(graph.dependencyAnalysis.referenceValidation).toMatchObject({
      state: 'denied',
      diagnostics: [
        expect.stringContaining('Conflicting generated config identity'),
      ],
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
  it('rejects omitted independent targets even when every serialized reference binds', () => {
    const references = dag();
    references['a.json'] = [];
    references['solution.json'] = ['a.json'];
    const graph = candidate(references);
    validateRestoredReferences(graph);
    expect(graph.dependencyAnalysis.referenceValidation?.state).toBe('denied');
    expect(
      graph.dependencyAnalysis.referenceValidation?.diagnostics.join('\n'),
    ).toContain(`missing ${file('b.json')}`);
  });
  it.each([
    ['tsc', 'tsgo'],
    ['tsc', 'vue-tsc'],
    ['tsgo', 'tsc'],
    ['tsgo', 'vue-tsc'],
    ['vue-tsc', 'tsc'],
    ['vue-tsc', 'tsgo'],
  ])('rejects an acyclic %s root reaching a %s target', (from, checker) => {
    const graph = candidate(dag());
    graph.sourceToDts = new Map([
      [from, new Map([['source-a', file('a.json')]])],
      [checker, new Map([['source-b', file('b.json')]])],
    ]);
    graph.sourceToBuild = new Map([[from, graph.sourceToBuild.get('tsc')!]]);
    graph.configToOutputBuild = new Map([
      [from, graph.configToOutputBuild.get('tsc')!],
    ]);
    graph.checkerEntries = new Map([[from, file('entry.json')]]);
    validateRestoredReferences(graph);
    expect(graph.dependencyAnalysis.referenceValidation?.state).toBe('denied');
    expect(
      graph.dependencyAnalysis.referenceValidation?.diagnostics.join('\n'),
    ).toContain('Cross-checker generated reference');
  });
});
