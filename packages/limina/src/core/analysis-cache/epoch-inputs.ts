import { type AnalysisRead, withAnalysisReads } from '#utils/analysis-input';
import { AnalysisInputDriftError } from './contracts';
import { analysisHash } from './identity';

/**
Discovery and runtime observations protect this epoch independently of native reuse.
*/
export class EpochInputs {
  readonly #reads = new Map<string, { version: string; input: AnalysisRead }>();

  #observe(input: AnalysisRead): void {
    const version = analysisHash(input.value);
    const prior = this.#reads.get(input.key);
    if (prior !== undefined && prior.version !== version)
      throw new AnalysisInputDriftError(input.path);
    this.#reads.set(input.key, { version, input });
  }

  run<T>(operation: () => T): T {
    return withAnalysisReads((input) => this.#observe(input), operation);
  }

  async assertStable(): Promise<void> {
    for (const { input, version } of this.#reads.values()) {
      if (analysisHash(await input.read()) !== version)
        throw new AnalysisInputDriftError(input.path);
    }
  }
}
