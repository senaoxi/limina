import {
  createAnalysisRun,
  createNoopMetricsRecorder,
} from '../application/analysis/analysis-run';
import { ArchitectureValidationWorkflow } from '../application/validation/architecture-workflow';
import {
  type ArchitectureValidationStageFactories,
  dispatchValidationStages,
  planArchitectureValidationStages,
} from '../application/validation/planner';
import { identifier } from '../domain/shared/identifiers';

function createRun() {
  return createAnalysisRun({
    generation: identifier<'AnalysisGeneration'>('generation-1'),
    metrics: createNoopMetricsRecorder(),
    signal: new AbortController().signal,
    snapshotToken: identifier<'RepositorySnapshotToken'>('snapshot-1'),
  });
}

describe('architecture validation planner', () => {
  it('prepares only stages required by enabled rules', async () => {
    const workspaceExecute = vi.fn(async () => []);
    const unused = vi.fn();
    const factories: ArchitectureValidationStageFactories = {
      declarationBuild: unused,
      importFacts: unused,
      outputBuild: unused,
      packageArtifacts: unused,
      projects: unused,
      sourceDependencies: unused,
      workspace: (ruleIds) => ({
        execute: workspaceExecute,
        inputKind: 'workspace',
        ruleIds,
      }),
    };

    const tasks = planArchitectureValidationStages(
      [{ inputKind: 'workspace', ruleId: 'workspace/region-boundary' }],
      factories,
    );

    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      inputKind: 'workspace',
      ruleIds: ['workspace/region-boundary'],
    });
    expect(unused).not.toHaveBeenCalled();

    await dispatchValidationStages(tasks, createRun());
    expect(workspaceExecute).toHaveBeenCalledTimes(1);
  });

  it('projects and validates only the selected built-in input kind', async () => {
    const packageId = identifier<'PackageId'>('package-a');
    const workspace = vi.fn(async () => ({
      kind: 'workspace' as const,
      packages: Object.freeze({
        [packageId]: Object.freeze({
          exports: Object.freeze([]),
          id: packageId,
          labels: Object.freeze([]),
          rootPath: '/repo/package-a',
        }),
      }),
      regions: Object.freeze([]),
    }));
    const unexpected = vi.fn(async () => {
      throw new Error('unselected view must not be prepared');
    });
    const workflow = new ArchitectureValidationWorkflow({
      declarationBuild: { get: unexpected as never },
      importFacts: { get: unexpected as never },
      outputBuild: { get: unexpected as never },
      packageArtifacts: { get: unexpected as never },
      projects: { get: unexpected as never },
      sourceDependencies: { get: unexpected as never },
      workspace: { get: workspace },
    });
    const tasks = workflow.plan(['workspace/package-region-membership']);

    const issues = await dispatchValidationStages(tasks, createRun());

    expect(workspace).toHaveBeenCalledTimes(1);
    expect(unexpected).not.toHaveBeenCalled();
    expect(issues).toMatchObject([
      {
        messageId: 'missing',
        ruleId: 'workspace/package-region-membership',
      },
    ]);
  });
});
