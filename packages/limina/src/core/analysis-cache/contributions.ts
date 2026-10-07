import { performance } from 'node:perf_hooks';
import type { ImportRecord } from '../import-analysis/records';
import type { AnalysisCacheMetrics, ReferenceContribution } from './contracts';
import { analysisHash } from './identity';
import type { AnalysisInputs } from './inputs';
import { isSameData } from './snapshot-records';

type ContributionInput = Omit<ReferenceContribution, 'sourceVersion'>;

/**
Current authority produces each transaction; persisted contributions grant no authority.
*/
export class ReferenceContributions {
  readonly #inputs: AnalysisInputs;
  readonly #metrics: AnalysisCacheMetrics;
  readonly #previous: Record<string, ReferenceContribution[]>;
  #pending: ContributionInput[] | undefined;
  readonly records: Record<string, ReferenceContribution[]> = {};

  constructor(
    inputs: AnalysisInputs,
    previous: Record<string, ReferenceContribution[]> = {},
  ) {
    this.#inputs = inputs;
    this.#metrics = inputs.metrics;
    this.#previous = previous;
  }

  #version(occurrence: ImportRecord): string {
    return this.#inputs.observe(occurrence.filePath, 'content').expectedVersion;
  }

  #replace(
    config: string,
    checker: string,
    contributions: ContributionInput[],
  ): void {
    const replacements: Record<string, ReferenceContribution[]> = {};
    for (const contribution of contributions)
      this.#add(replacements, contribution);
    this.#removeProject(config, checker);
    for (const [id, values] of Object.entries(replacements)) {
      this.records[id] = this.#retained(id, values);
    }
  }

  #removeProject(config: string, checker: string): void {
    const prior = Object.entries(this.records).filter(([, values]) =>
      values.some(
        (value) =>
          value.fromConfigPath === config && value.fromChecker === checker,
      ),
    );
    for (const [id] of prior) delete this.records[id];
  }

  #retained(
    id: string,
    values: ReferenceContribution[],
  ): ReferenceContribution[] {
    const previous = this.#previous[id];
    return isSameData(previous, values) ? previous! : values;
  }

  #add(
    records: Record<string, ReferenceContribution[]>,
    contribution: ContributionInput,
  ): void {
    const id = analysisHash([
      contribution.fromConfigPath,
      contribution.fromChecker,
      contribution.occurrence.filePath,
    ]);
    const values = records[id] ?? [];
    const next = {
      ...contribution,
      sourceVersion: this.#version(contribution.occurrence),
    };
    const key = analysisHash(next);
    if (values.every((value) => analysisHash(value) !== key))
      values.push(structuredClone(next));
    records[id] = values;
  }

  record(contribution: ContributionInput): void {
    this.#pending?.push(contribution);
  }

  restoreValidatedGraph(): void {
    Object.assign(this.records, this.#previous);
  }

  replaceProject(options: {
    config: string;
    checker: string;
    collect(): void;
    complete: boolean;
  }): void {
    const startedAt = performance.now();
    const pending: ContributionInput[] = [];
    this.#pending = pending;
    try {
      options.collect();
      if (options.complete)
        this.#replace(options.config, options.checker, pending);
    } finally {
      this.#pending = undefined;
      this.#metrics.projectionMs += performance.now() - startedAt;
    }
  }

  counts(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const contribution of Object.values(this.records).flat()) {
      const id = analysisHash([
        contribution.fromConfigPath,
        contribution.fromChecker,
        contribution.toConfigPath,
        contribution.toChecker,
        contribution.kind,
      ]);
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
  }
}
