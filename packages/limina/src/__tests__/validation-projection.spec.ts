import {
  createAnalysisRun,
  createNoopMetricsRecorder,
} from '../application/analysis/analysis-run';
import {
  SourceDependencyGraphProvider,
  WorkspaceTopologyProvider,
} from '../application/analysis/providers';
import {
  SourceDependencyValidationViewProvider,
  WorkspaceValidationViewProvider,
} from '../application/validation/projectors';
import { ValidationReferencePoolProvider } from '../application/validation/reference-pool-provider';
import { identifier } from '../domain/shared/identifiers';
import { assertImmutableValidationValue } from '../domain/validation/immutability';

function createRun(generation = 'generation-1') {
  return createAnalysisRun({
    generation: identifier<'AnalysisGeneration'>(generation),
    metrics: createNoopMetricsRecorder(),
    signal: new AbortController().signal,
    snapshotToken: identifier<'RepositorySnapshotToken'>(
      `snapshot-${generation}`,
    ),
  });
}

describe('validation projection', () => {
  it('constructs one immutable view per generation and shares package DTOs', async () => {
    const packageId = identifier<'PackageId'>('package-a');
    const topologyLoader = vi.fn(async () => ({
      packageIds: [packageId],
      regions: [
        {
          boundaryPaths: [],
          exclusionProvenance: [],
          id: identifier<'WorkspaceRegionId'>('root-region'),
          packageIds: [packageId],
          rootPath: '/repo',
        },
      ],
    }));
    const referenceLoader = vi.fn(async () => ({
      files: [],
      locations: [],
      packages: [
        {
          exports: [],
          id: packageId,
          labels: ['domain:core'],
          name: '@fixture/a',
          rootPath: '/repo/packages/a',
        },
      ],
      projects: [],
    }));
    const topology = new WorkspaceTopologyProvider(topologyLoader);
    const pool = new ValidationReferencePoolProvider({ get: referenceLoader });
    const projector = new WorkspaceValidationViewProvider(topology, pool);
    const run = createRun();

    const [first, second] = await Promise.all([
      projector.get(run),
      projector.get(run),
    ]);

    expect(first).toBe(second);
    expect(first.packages[packageId]).toBe(
      (await pool.get(run)).packages[packageId],
    );
    expect(topologyLoader).toHaveBeenCalledTimes(1);
    expect(referenceLoader).toHaveBeenCalledTimes(1);
    assertImmutableValidationValue(first);
    expect(structuredClone(first)).toEqual(first);

    await projector.get(createRun('generation-2'));
    expect(topologyLoader).toHaveBeenCalledTimes(2);
  });

  it('rejects mutable and behavior-bearing view shapes in invariant tests', () => {
    expect(() => assertImmutableValidationValue(new Map())).toThrow(/Map/u);
    expect(() =>
      assertImmutableValidationValue(Object.freeze({ run: () => {} })),
    ).toThrow(/functions/u);
    expect(() => assertImmutableValidationValue({ kind: 'workspace' })).toThrow(
      /frozen/u,
    );
  });

  it('projects stable team and domain boundary classifications', async () => {
    const sourceProjectId = identifier<'ProjectId'>('project-source');
    const targetProjectId = identifier<'ProjectId'>('project-target');
    const fileId = identifier<'FileId'>('file-source');
    const packageId = identifier<'PackageId'>('package-source');
    const graph = new SourceDependencyGraphProvider(async () => ({
      edges: [
        {
          evidenceIds: [],
          fromFileId: fileId,
          fromPackageId: packageId,
          fromProjectId: sourceProjectId,
          id: identifier<'SourceDependencyEdgeId'>('edge-1'),
          kind: 'runtime',
          target: {
            fileId: identifier<'FileId'>('file-target'),
            kind: 'workspace-file',
            projectId: targetProjectId,
          },
        },
      ],
      evidence: [],
      roots: [sourceProjectId],
    }));
    const pool = new ValidationReferencePoolProvider({
      async get() {
        return {
          files: [],
          locations: [],
          packages: [],
          projects: [
            {
              checkerIds: [],
              configPath: '/repo/source/tsconfig.json',
              domain: 'product',
              id: sourceProjectId,
              labels: [],
              name: 'source',
              team: 'team-a',
            },
            {
              checkerIds: [],
              configPath: '/repo/target/tsconfig.json',
              domain: 'product',
              id: targetProjectId,
              labels: [],
              name: 'target',
              team: 'team-b',
            },
          ],
        };
      },
    });
    const view = await new SourceDependencyValidationViewProvider(
      graph,
      pool,
    ).get(createRun());

    expect(view.edges[0]?.boundary).toEqual({
      domain: 'same',
      team: 'cross',
    });
    expect(structuredClone(view)).toEqual(view);
  });
});
