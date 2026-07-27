import {
  type BuiltInArchitectureValidator,
  declarationCycleRule,
  importEvidenceIntegrityRule,
  outputBuildSelfEdgeRule,
  packageArtifactAccessRule,
  projectOwnershipConflictRule,
  sourceDependencyResolutionRule,
  workspaceRegionMembershipRule,
} from '../../domain/validation/built-in-rules';
import type { ArchitectureValidationInputKind } from '../../domain/validation/contracts';
import type { GovernanceIssue } from '../../domain/validation/issues';
import type { ValidationViewByKind } from '../../domain/validation/views';
import type { AnalysisRun } from '../analysis/analysis-run';
import {
  type ArchitectureValidationStageFactories,
  type ArchitectureValidationStageTask,
  planArchitectureValidationStages,
} from './planner';
import { createArchitectureValidatorRegistry } from './registry';
import { type PreparedTypedValidator, prepareTypedValidator } from './runner';

export interface ArchitectureValidationViewProviders {
  readonly declarationBuild: ValidationViewProvider<
    ValidationViewByKind['declaration-build']
  >;
  readonly importFacts: ValidationViewProvider<
    ValidationViewByKind['import-facts']
  >;
  readonly outputBuild: ValidationViewProvider<
    ValidationViewByKind['output-build']
  >;
  readonly packageArtifacts: ValidationViewProvider<
    ValidationViewByKind['package-artifacts']
  >;
  readonly projects: ValidationViewProvider<ValidationViewByKind['projects']>;
  readonly sourceDependencies: ValidationViewProvider<
    ValidationViewByKind['source-dependencies']
  >;
  readonly workspace: ValidationViewProvider<ValidationViewByKind['workspace']>;
}

export interface ValidationViewProvider<View> {
  get(run: AnalysisRun): Promise<View>;
}

interface PreparedArchitectureValidators {
  readonly declarationBuild: PreparedTypedValidator<
    ValidationViewByKind['declaration-build']
  >;
  readonly importFacts: PreparedTypedValidator<
    ValidationViewByKind['import-facts']
  >;
  readonly outputBuild: PreparedTypedValidator<
    ValidationViewByKind['output-build']
  >;
  readonly packageArtifacts: PreparedTypedValidator<
    ValidationViewByKind['package-artifacts']
  >;
  readonly projects: PreparedTypedValidator<ValidationViewByKind['projects']>;
  readonly sourceDependencies: PreparedTypedValidator<
    ValidationViewByKind['source-dependencies']
  >;
  readonly workspace: PreparedTypedValidator<ValidationViewByKind['workspace']>;
}

export const architectureValidatorRegistry: readonly BuiltInArchitectureValidator[] =
  createArchitectureValidatorRegistry([
    workspaceRegionMembershipRule,
    projectOwnershipConflictRule,
    importEvidenceIntegrityRule,
    sourceDependencyResolutionRule,
    declarationCycleRule,
    outputBuildSelfEdgeRule,
    packageArtifactAccessRule,
  ]);

const architectureRuleIds = Object.freeze(
  architectureValidatorRegistry.map(
    (registration) => registration.descriptor.id,
  ),
);

function createTask<
  Kind extends ArchitectureValidationInputKind & keyof ValidationViewByKind,
>(options: {
  readonly execute: (
    view: ValidationViewByKind[Kind],
    run: AnalysisRun,
  ) => Promise<readonly GovernanceIssue[]>;
  readonly inputKind: Kind;
  readonly prepareView: (
    run: AnalysisRun,
  ) => Promise<ValidationViewByKind[Kind]>;
  readonly ruleIds: readonly string[];
}): ArchitectureValidationStageTask {
  return Object.freeze({
    async execute(run: AnalysisRun): Promise<readonly GovernanceIssue[]> {
      return options.execute(await options.prepareView(run), run);
    },
    inputKind: options.inputKind,
    ruleIds: options.ruleIds,
  });
}

function requireEnabledRuleIds(enabledRuleIds: readonly string[]): void {
  const known = new Set<string>(architectureRuleIds);

  for (const ruleId of enabledRuleIds) {
    if (!known.has(ruleId)) {
      throw new Error(`Unknown built-in architecture rule "${ruleId}".`);
    }
  }
}

function prepareArchitectureValidators(): PreparedArchitectureValidators {
  const origin = { kind: 'built-in', suite: 'architecture' } as const;

  return {
    declarationBuild: prepareTypedValidator({
      configuredOptions: undefined,
      origin,
      registration: declarationCycleRule,
    }),
    importFacts: prepareTypedValidator({
      configuredOptions: undefined,
      origin,
      registration: importEvidenceIntegrityRule,
    }),
    outputBuild: prepareTypedValidator({
      configuredOptions: undefined,
      origin,
      registration: outputBuildSelfEdgeRule,
    }),
    packageArtifacts: prepareTypedValidator({
      configuredOptions: undefined,
      origin,
      registration: packageArtifactAccessRule,
    }),
    projects: prepareTypedValidator({
      configuredOptions: undefined,
      origin,
      registration: projectOwnershipConflictRule,
    }),
    sourceDependencies: prepareTypedValidator({
      configuredOptions: undefined,
      origin,
      registration: sourceDependencyResolutionRule,
    }),
    workspace: prepareTypedValidator({
      configuredOptions: undefined,
      origin,
      registration: workspaceRegionMembershipRule,
    }),
  };
}

function createStageFactories(
  views: ArchitectureValidationViewProviders,
  validators: PreparedArchitectureValidators,
): ArchitectureValidationStageFactories {
  return {
    declarationBuild: (ruleIds) =>
      createTask({
        execute: (view, run) => validators.declarationBuild.execute(view, run),
        inputKind: 'declaration-build',
        prepareView: (run) => views.declarationBuild.get(run),
        ruleIds,
      }),
    importFacts: (ruleIds) =>
      createTask({
        execute: (view, run) => validators.importFacts.execute(view, run),
        inputKind: 'import-facts',
        prepareView: (run) => views.importFacts.get(run),
        ruleIds,
      }),
    outputBuild: (ruleIds) =>
      createTask({
        execute: (view, run) => validators.outputBuild.execute(view, run),
        inputKind: 'output-build',
        prepareView: (run) => views.outputBuild.get(run),
        ruleIds,
      }),
    packageArtifacts: (ruleIds) =>
      createTask({
        execute: (view, run) => validators.packageArtifacts.execute(view, run),
        inputKind: 'package-artifacts',
        prepareView: (run) => views.packageArtifacts.get(run),
        ruleIds,
      }),
    projects: (ruleIds) =>
      createTask({
        execute: (view, run) => validators.projects.execute(view, run),
        inputKind: 'projects',
        prepareView: (run) => views.projects.get(run),
        ruleIds,
      }),
    sourceDependencies: (ruleIds) =>
      createTask({
        execute: (view, run) =>
          validators.sourceDependencies.execute(view, run),
        inputKind: 'source-dependencies',
        prepareView: (run) => views.sourceDependencies.get(run),
        ruleIds,
      }),
    workspace: (ruleIds) =>
      createTask({
        execute: (view, run) => validators.workspace.execute(view, run),
        inputKind: 'workspace',
        prepareView: (run) => views.workspace.get(run),
        ruleIds,
      }),
  };
}

function collectEnabledRegistrations(enabledRuleIds: ReadonlySet<string>) {
  return architectureValidatorRegistry
    .filter((registration) => enabledRuleIds.has(registration.descriptor.id))
    .map((registration) => ({
      inputKind: registration.descriptor.inputKind,
      ruleId: registration.descriptor.id,
    }));
}

export class ArchitectureValidationWorkflow {
  readonly #views: ArchitectureValidationViewProviders;

  constructor(views: ArchitectureValidationViewProviders) {
    this.#views = views;
  }

  plan(
    enabledRuleIds: readonly string[] = architectureRuleIds,
  ): readonly ArchitectureValidationStageTask[] {
    requireEnabledRuleIds(enabledRuleIds);
    const enabled = new Set(enabledRuleIds);
    const validators = prepareArchitectureValidators();
    const factories = createStageFactories(this.#views, validators);

    return planArchitectureValidationStages(
      collectEnabledRegistrations(enabled),
      factories,
    );
  }
}
