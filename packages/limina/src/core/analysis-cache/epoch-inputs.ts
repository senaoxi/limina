import { type AnalysisRead, withAnalysisReads } from '#utils/analysis-input';
import { AnalysisInputDriftError, type DiscoveryRecord } from './contracts';
import { pathBinding } from './directory-fingerprint';
import { replayDiscoveryRead } from './discovery-reads';
import { analysisHash } from './identity';

interface Observation {
  version: string;
  binding: string;
  input: AnalysisRead;
}
function isSameObservation(
  before: Observation | undefined,
  after: Observation,
): boolean {
  return before === undefined || isSameVersion(before, after);
}
function isSameVersion(
  before: { version: string; binding: string },
  after: { version: string; binding: string },
): boolean {
  return [
    before.version === after.version,
    before.binding === after.binding,
  ].every(Boolean);
}
function observation(input: AnalysisRead): Observation {
  return {
    version: analysisHash(input.value),
    binding: analysisHash(pathBinding(input.path)),
    input,
  };
}
/**
Discovery and runtime observations protect this epoch independently of native reuse.
*/
export class EpochInputs {
  readonly #reads = new Map<string, Observation>();
  #observe(input: AnalysisRead): void {
    const next = observation(input);
    if (!isSameObservation(this.#reads.get(input.key), next))
      throw new AnalysisInputDriftError(input.path);
    this.#reads.set(input.key, next);
  }
  run<T>(operation: () => T): T {
    return withAnalysisReads((input) => this.#observe(input), operation);
  }
  async assertStable(): Promise<void> {
    for (const prior of this.#reads.values()) {
      const current = observation({
        ...prior.input,
        value: await prior.input.read(),
      });
      if (!isSameVersion(prior, current))
        throw new AnalysisInputDriftError(prior.input.path);
    }
  }
  snapshot(): DiscoveryRecord[] | undefined {
    const result: DiscoveryRecord[] = [];
    for (const { input, version, binding } of this.#reads.values()) {
      if (input.descriptor === undefined) return undefined;
      result.push({
        key: input.key,
        path: input.path,
        descriptor: input.descriptor,
        version,
        binding,
      });
    }
    return result;
  }
  async validate(records: readonly DiscoveryRecord[]): Promise<boolean> {
    for (const record of records) {
      const read = () => replayDiscoveryRead(record.descriptor);
      const input = { ...record, value: await read(), read };
      if (!isSameVersion(record, observation(input))) return false;
      this.#observe(input);
    }
    return true;
  }
}
