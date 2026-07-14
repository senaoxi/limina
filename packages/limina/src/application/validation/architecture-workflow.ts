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
import { prepareTypedValidator } from './runner';

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
    const origin = { kind: 'built-in', suite: 'architecture' } as const;
    const workspace = prepareTypedValidator({
      configuredOptions: undefined,
      origin,
      registration: workspaceRegionMembershipRule,
    });
    const projects = prepareTypedValidator({
      configuredOptions: undefined,
      origin,
      registration: projectOwnershipConflictRule,
    });
    const imports = prepareTypedValidator({
      configuredOptions: undefined,
      origin,
      registration: importEvidenceIntegrityRule,
    });
    const sourceDependencies = prepareTypedValidator({
      configuredOptions: undefined,
      origin,
      registration: sourceDependencyResolutionRule,
    });
    const declarationBuild = prepareTypedValidator({
      configuredOptions: undefined,
      origin,
      registration: declarationCycleRule,
    });
    const outputBuild = prepareTypedValidator({
      configuredOptions: undefined,
      origin,
      registration: outputBuildSelfEdgeRule,
    });
    const packageArtifacts = prepareTypedValidator({
      configuredOptions: undefined,
      origin,
      registration: packageArtifactAccessRule,
    });
    const factories: ArchitectureValidationStageFactories = {
      declarationBuild: (ruleIds) =>
        createTask({
          execute: (view, run) => declarationBuild.execute(view, run),
          inputKind: 'declaration-build',
          prepareView: (run) => this.#views.declarationBuild.get(run),
          ruleIds,
        }),
      importFacts: (ruleIds) =>
        createTask({
          execute: (view, run) => imports.execute(view, run),
          inputKind: 'import-facts',
          prepareView: (run) => this.#views.importFacts.get(run),
          ruleIds,
        }),
      outputBuild: (ruleIds) =>
        createTask({
          execute: (view, run) => outputBuild.execute(view, run),
          inputKind: 'output-build',
          prepareView: (run) => this.#views.outputBuild.get(run),
          ruleIds,
        }),
      packageArtifacts: (ruleIds) =>
        createTask({
          execute: (view, run) => packageArtifacts.execute(view, run),
          inputKind: 'package-artifacts',
          prepareView: (run) => this.#views.packageArtifacts.get(run),
          ruleIds,
        }),
      projects: (ruleIds) =>
        createTask({
          execute: (view, run) => projects.execute(view, run),
          inputKind: 'projects',
          prepareView: (run) => this.#views.projects.get(run),
          ruleIds,
        }),
      sourceDependencies: (ruleIds) =>
        createTask({
          execute: (view, run) => sourceDependencies.execute(view, run),
          inputKind: 'source-dependencies',
          prepareView: (run) => this.#views.sourceDependencies.get(run),
          ruleIds,
        }),
      workspace: (ruleIds) =>
        createTask({
          execute: (view, run) => workspace.execute(view, run),
          inputKind: 'workspace',
          prepareView: (run) => this.#views.workspace.get(run),
          ruleIds,
        }),
    };

    return planArchitectureValidationStages(
      architectureValidatorRegistry
        .filter((registration) => enabled.has(registration.descriptor.id))
        .map((registration) => ({
          inputKind: registration.descriptor.inputKind,
          ruleId: registration.descriptor.id,
        })),
      factories,
    );
  }
}
