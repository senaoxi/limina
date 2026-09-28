import type { GovernanceIssue } from '../../domain/validation/issues';
import {
  packageOutputFindingRule,
  releaseAssessmentFindingRule,
} from '../../domain/validation/output-release-rules';
import type {
  PackageOutputValidationView,
  ReleaseAssessmentValidationView,
} from '../../domain/validation/views';
import type { AnalysisRun } from '../analysis/analysis-run';
import { createTypedValidatorRegistry } from './registry';
import { prepareTypedValidator } from './runner';

export interface PackageOutputValidationViewReader {
  get(run: AnalysisRun): Promise<PackageOutputValidationView>;
}

export interface ReleaseAssessmentValidationViewReader {
  get(run: AnalysisRun): Promise<ReleaseAssessmentValidationView>;
}

export interface ValidationSuiteFailurePolicy {
  readonly externalToolFailure: 'execution-failure';
  readonly networkFailure: 'execution-failure' | 'not-applicable';
  readonly validatorFailure: 'execution-failure';
}

export const packageOutputFailurePolicy: ValidationSuiteFailurePolicy =
  Object.freeze({
    externalToolFailure: 'execution-failure',
    networkFailure: 'not-applicable',
    validatorFailure: 'execution-failure',
  });

export const releaseFailurePolicy: ValidationSuiteFailurePolicy = Object.freeze(
  {
    externalToolFailure: 'execution-failure',
    networkFailure: 'execution-failure',
    validatorFailure: 'execution-failure',
  },
);

export const packageOutputValidatorRegistry: readonly [
  typeof packageOutputFindingRule,
] = createTypedValidatorRegistry([packageOutputFindingRule]);

export const releaseValidatorRegistry: readonly [
  typeof releaseAssessmentFindingRule,
] = createTypedValidatorRegistry([releaseAssessmentFindingRule]);

export class PackageOutputValidationWorkflow {
  readonly #view: PackageOutputValidationViewReader;

  constructor(view: PackageOutputValidationViewReader) {
    this.#view = view;
  }

  async execute(run: AnalysisRun): Promise<readonly GovernanceIssue[]> {
    const validator = prepareTypedValidator({
      configuredOptions: undefined,
      origin: { kind: 'built-in', suite: 'package-output' },
      registration: packageOutputFindingRule,
    });

    return validator.execute(await this.#view.get(run), run);
  }
}

export class ReleaseValidationWorkflow {
  readonly #view: ReleaseAssessmentValidationViewReader;

  constructor(view: ReleaseAssessmentValidationViewReader) {
    this.#view = view;
  }

  async execute(run: AnalysisRun): Promise<readonly GovernanceIssue[]> {
    const validator = prepareTypedValidator({
      configuredOptions: undefined,
      origin: { kind: 'built-in', suite: 'release' },
      registration: releaseAssessmentFindingRule,
    });

    return validator.execute(await this.#view.get(run), run);
  }
}
