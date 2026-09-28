import type { AnalysisGeneration } from '../../domain/shared/identifiers';
import { freezeArray } from '../../domain/validation/immutability';
import type {
  PackageOutputValidationView,
  ReleaseAssessmentValidationView,
} from '../../domain/validation/views';
import type { AnalysisRun } from '../analysis/analysis-run';
import type {
  PackageOutputProvider,
  ReleaseAssessmentProvider,
} from '../analysis/providers';
import { recordProjection } from './projector-shared';
import type { ValidationReferencePoolProvider } from './reference-pool-provider';

export class PackageOutputValidationViewProvider {
  readonly #generations = new Map<
    AnalysisGeneration,
    Promise<PackageOutputValidationView>
  >();
  readonly #output: PackageOutputProvider;
  readonly #pool: ValidationReferencePoolProvider;

  constructor(
    output: PackageOutputProvider,
    pool: ValidationReferencePoolProvider,
  ) {
    this.#output = output;
    this.#pool = pool;
  }

  get(run: AnalysisRun): Promise<PackageOutputValidationView> {
    const cached = this.#generations.get(run.generation);

    if (cached) {
      return cached;
    }

    const startedAt = performance.now();
    const view = Promise.all([this.#output.get(run), this.#pool.get(run)]).then(
      ([output, pool]) => {
        const result: PackageOutputValidationView = Object.freeze({
          ...pool,
          findings: freezeArray(
            output.findings.map((finding) =>
              Object.freeze({
                code: finding.code,
                evidence: freezeArray(
                  finding.evidenceIds.map((id) =>
                    Object.freeze({ id, kind: 'output', value: id }),
                  ),
                ),
                packageId: finding.packageId,
                tool: finding.tool,
              }),
            ),
          ),
          kind: 'package-output',
        });
        recordProjection({
          count: result.findings.length,
          kind: result.kind,
          run,
          startedAt,
        });
        return result;
      },
    );
    this.#generations.set(run.generation, view);
    return view;
  }

  releaseGeneration(generation: AnalysisGeneration): void {
    this.#generations.delete(generation);
  }
}

export class ReleaseAssessmentValidationViewProvider {
  readonly #assessment: ReleaseAssessmentProvider;
  readonly #generations = new Map<
    AnalysisGeneration,
    Promise<ReleaseAssessmentValidationView>
  >();
  readonly #pool: ValidationReferencePoolProvider;

  constructor(
    assessment: ReleaseAssessmentProvider,
    pool: ValidationReferencePoolProvider,
  ) {
    this.#assessment = assessment;
    this.#pool = pool;
  }

  get(run: AnalysisRun): Promise<ReleaseAssessmentValidationView> {
    const cached = this.#generations.get(run.generation);

    if (cached) {
      return cached;
    }

    const startedAt = performance.now();
    const view = Promise.all([
      this.#assessment.get(run),
      this.#pool.get(run),
    ]).then(([assessment, pool]) => {
      const result: ReleaseAssessmentValidationView = Object.freeze({
        ...pool,
        findings: freezeArray(
          assessment.findings.map((finding) => Object.freeze({ ...finding })),
        ),
        kind: 'release-assessment',
      });
      recordProjection({
        count: result.findings.length,
        kind: result.kind,
        run,
        startedAt,
      });
      return result;
    });
    this.#generations.set(run.generation, view);
    return view;
  }

  releaseGeneration(generation: AnalysisGeneration): void {
    this.#generations.delete(generation);
  }
}
