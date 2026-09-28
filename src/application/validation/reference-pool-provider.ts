import type { AnalysisGeneration } from '../../domain/shared/identifiers';
import {
  freezeArray,
  freezeRecord,
} from '../../domain/validation/immutability';
import type {
  ValidationEntityReferences,
  ValidationFile,
  ValidationLocation,
  ValidationPackage,
  ValidationProject,
} from '../../domain/validation/views';
import type { AnalysisRun } from '../analysis/analysis-run';

export interface ValidationReferenceSource {
  readonly files: readonly ValidationFile[];
  readonly locations: readonly ValidationLocation[];
  readonly packages: readonly ValidationPackage[];
  readonly projects: readonly ValidationProject[];
}

export interface ValidationReferenceSourceProvider {
  get(run: AnalysisRun): Promise<ValidationReferenceSource>;
}

function freezeFile(file: ValidationFile): ValidationFile {
  return Object.freeze({ ...file });
}

function freezeLocation(location: ValidationLocation): ValidationLocation {
  return Object.freeze({ ...location });
}

function freezePackage(pkg: ValidationPackage): ValidationPackage {
  return Object.freeze({
    ...pkg,
    exports: freezeArray(
      pkg.exports.map((entry) =>
        Object.freeze({ ...entry, targets: freezeArray(entry.targets) }),
      ),
    ),
    labels: freezeArray(pkg.labels),
  });
}

function freezeProject(project: ValidationProject): ValidationProject {
  return Object.freeze({
    ...project,
    checkerIds: freezeArray(project.checkerIds),
    labels: freezeArray(project.labels),
  });
}

function estimateReferenceBytes(source: ValidationReferenceSource): number {
  return (
    source.files.reduce((total, file) => total + file.path.length + 48, 0) +
    source.locations.length * 48 +
    source.packages.reduce(
      (total, pkg) =>
        total + pkg.rootPath.length + (pkg.name?.length ?? 0) + 96,
      0,
    ) +
    source.projects.reduce(
      (total, project) =>
        total + project.configPath.length + project.name.length + 96,
      0,
    )
  );
}

/** Owns shared immutable validation DTOs for exactly one analysis generation. */
export class ValidationReferencePoolProvider {
  readonly #generations = new Map<
    AnalysisGeneration,
    Promise<ValidationEntityReferences>
  >();
  readonly #sourceProvider: ValidationReferenceSourceProvider;

  constructor(sourceProvider: ValidationReferenceSourceProvider) {
    this.#sourceProvider = sourceProvider;
  }

  get(run: AnalysisRun): Promise<ValidationEntityReferences> {
    const cached = this.#generations.get(run.generation);

    if (cached) {
      run.metrics.record({
        kind: 'validation-reference-pool',
        name: 'provider-cache-hit',
        provider: 'validation-reference-pool',
      });
      return cached;
    }

    run.metrics.record({
      kind: 'validation-reference-pool',
      name: 'provider-cache-miss',
      provider: 'validation-reference-pool',
    });

    const startedAt = performance.now();
    const projected = this.#sourceProvider.get(run).then((source) => {
      const pool = Object.freeze({
        files: freezeRecord(
          source.files.map((file) => [file.id, freezeFile(file)]),
        ),
        locations: freezeRecord(
          source.locations.map((location) => [
            location.id,
            freezeLocation(location),
          ]),
        ),
        packages: freezeRecord(
          source.packages.map((pkg) => [pkg.id, freezePackage(pkg)]),
        ),
        projects: freezeRecord(
          source.projects.map((project) => [
            project.id,
            freezeProject(project),
          ]),
        ),
      });

      run.metrics.record({
        count:
          source.files.length +
          source.locations.length +
          source.packages.length +
          source.projects.length,
        durationMs: performance.now() - startedAt,
        estimatedBytes: estimateReferenceBytes(source),
        kind: 'validation-reference-pool',
        name: 'projection',
      });

      return pool;
    });

    this.#generations.set(run.generation, projected);
    return projected;
  }

  releaseGeneration(generation: AnalysisGeneration): void {
    this.#generations.delete(generation);
  }
}
