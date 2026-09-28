import type { ArchitectureValidationInputKind } from '../../domain/validation/contracts';
import type { GovernanceIssue } from '../../domain/validation/issues';
import type { AnalysisRun } from '../analysis/analysis-run';

export interface EnabledArchitectureRegistration {
  readonly inputKind: ArchitectureValidationInputKind;
  readonly ruleId: string;
}

export interface ArchitectureValidationStageTask {
  readonly inputKind: ArchitectureValidationInputKind;
  readonly ruleIds: readonly string[];
  execute(run: AnalysisRun): Promise<readonly GovernanceIssue[]>;
}

export interface ArchitectureValidationStageFactories {
  declarationBuild(ruleIds: readonly string[]): ArchitectureValidationStageTask;
  importFacts(ruleIds: readonly string[]): ArchitectureValidationStageTask;
  outputBuild(ruleIds: readonly string[]): ArchitectureValidationStageTask;
  packageArtifacts(ruleIds: readonly string[]): ArchitectureValidationStageTask;
  projects(ruleIds: readonly string[]): ArchitectureValidationStageTask;
  sourceDependencies(
    ruleIds: readonly string[],
  ): ArchitectureValidationStageTask;
  workspace(ruleIds: readonly string[]): ArchitectureValidationStageTask;
}

type StageFactory = (
  ruleIds: readonly string[],
) => ArchitectureValidationStageTask;

function createStage(
  kind: ArchitectureValidationInputKind,
  ruleIds: readonly string[],
  factories: ArchitectureValidationStageFactories,
): ArchitectureValidationStageTask {
  const factoryByKind: Record<ArchitectureValidationInputKind, StageFactory> = {
    'declaration-build': (ids) => factories.declarationBuild(ids),
    'import-facts': (ids) => factories.importFacts(ids),
    'output-build': (ids) => factories.outputBuild(ids),
    'package-artifacts': (ids) => factories.packageArtifacts(ids),
    projects: (ids) => factories.projects(ids),
    'source-dependencies': (ids) => factories.sourceDependencies(ids),
    workspace: (ids) => factories.workspace(ids),
  };

  return factoryByKind[kind](ruleIds);
}

export function planArchitectureValidationStages(
  registrations: readonly EnabledArchitectureRegistration[],
  factories: ArchitectureValidationStageFactories,
): readonly ArchitectureValidationStageTask[] {
  const grouped = new Map<ArchitectureValidationInputKind, string[]>();

  for (const registration of registrations) {
    const group = grouped.get(registration.inputKind) ?? [];
    group.push(registration.ruleId);
    grouped.set(registration.inputKind, group);
  }

  const kindOrder: readonly ArchitectureValidationInputKind[] = [
    'workspace',
    'projects',
    'import-facts',
    'source-dependencies',
    'declaration-build',
    'output-build',
    'package-artifacts',
  ];

  return Object.freeze(
    kindOrder.flatMap((kind) => {
      const ruleIds = grouped.get(kind);

      return ruleIds
        ? [createStage(kind, Object.freeze([...ruleIds].sort()), factories)]
        : [];
    }),
  );
}

export async function dispatchValidationStages(
  tasks: readonly ArchitectureValidationStageTask[],
  run: AnalysisRun,
): Promise<readonly GovernanceIssue[]> {
  const results = await Promise.all(tasks.map((task) => task.execute(run)));

  return Object.freeze(results.flat());
}
