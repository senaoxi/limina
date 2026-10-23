import {
  type AnalysisRead,
  withAdditionalAnalysisReads,
  withAnalysisReads,
} from '#utils/analysis-input';
import { compareCodeUnits } from '#utils/collections';
import { AnalysisInputDriftError, type DiscoveryRecord } from './contracts';
import { pathBinding, PathBindingReplay } from './directory-fingerprint';
import {
  replayDiscoveryRead,
  replaySynchronousDiscoveryRead,
} from './discovery-reads';
import { analysisHash } from './identity';
import { isAffectedByOutput, isManagedChange } from './managed-output-reads';

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
function globMembership(value: unknown): unknown {
  return Array.isArray(value) ? value.toSorted(compareCodeUnits) : value;
}
function observedValue(input: AnalysisRead): unknown {
  // Enumeration order is not membership; ordered configuration reads stay exact.
  return input.descriptor?.kind === 'glob'
    ? globMembership(input.value)
    : input.value;
}
function observation(input: AnalysisRead): Observation {
  return {
    version: analysisHash(observedValue(input)),
    binding: analysisHash(pathBinding(input.path)),
    input,
  };
}

async function readObservation(input: AnalysisRead): Promise<Observation> {
  return observation({ ...input, value: await input.read() });
}

function requireStable(
  prior: Observation,
  current: Observation,
  outputs?: ReadonlySet<string>,
): void {
  const isStable = [
    isSameVersion(prior, current),
    isManagedChange(prior.input, current.input.value, outputs),
  ].some(Boolean);
  if (!isStable) throw new AnalysisInputDriftError(prior.input.path);
}

/**
One read-only validation round; never retain across mutation or launch.
*/
export class EpochInputReplay {
  readonly #reads = new Map<string, Promise<Observation>>();
  readonly #bindings = new PathBindingReplay();

  read(input: AnalysisRead): Promise<Observation> {
    const key = JSON.stringify([input.key, input.path, input.descriptor]);
    let current = this.#reads.get(key);
    if (current === undefined) {
      current = this.#bindings.run(() => readObservation(input));
      this.#reads.set(key, current);
    }
    return current;
  }
}
/**
Discovery and runtime observations protect this epoch independently of native reuse.
*/
export class EpochInputs {
  readonly #reads = new Map<string, Observation>();
  #observe(input: AnalysisRead): void {
    this.#recordObservation(observation(input));
  }
  #recordObservation(next: Observation): void {
    const { input } = next;
    if (!isSameObservation(this.#reads.get(input.key), next))
      throw new AnalysisInputDriftError(input.path);
    this.#reads.set(input.key, next);
  }
  #validateSynchronousRecord(record: DiscoveryRecord): boolean {
    const descriptor = record.descriptor;
    if (descriptor.kind === 'glob') return false;
    const read = () => replaySynchronousDiscoveryRead(descriptor);
    const input = { ...record, value: read(), read };
    const next = observation(input);
    if (!isSameVersion(record, next)) return false;
    this.#recordObservation(next);
    return true;
  }
  run<T>(operation: () => T): T {
    return withAnalysisReads((input) => this.#observe(input), operation);
  }
  collect<T>(operation: () => T): T {
    return withAdditionalAnalysisReads(
      (input) => this.#observe(input),
      operation,
    );
  }
  select(paths: ReadonlySet<string>): EpochInputs {
    const selected = new EpochInputs();
    for (const [key, value] of this.#reads)
      if (paths.has(value.input.path)) selected.#reads.set(key, value);
    return selected;
  }
  append(inputs: EpochInputs): void {
    for (const [key, value] of inputs.#reads) {
      if (!isSameObservation(this.#reads.get(key), value))
        throw new AnalysisInputDriftError(value.input.path);
      this.#reads.set(key, value);
    }
  }
  get paths(): ReadonlySet<string> {
    return new Set(this.#reads.values().map((value) => value.input.path));
  }
  affectedOutputs(outputs: ReadonlySet<string>): Set<string> {
    return new Set(
      [...outputs].filter((file) =>
        this.#reads
          .values()
          .some((value) => isAffectedByOutput(value.input, file)),
      ),
    );
  }
  async assertStable(
    outputs?: ReadonlySet<string>,
    replay: EpochInputReplay = new EpochInputReplay(),
  ): Promise<void> {
    for (const prior of this.#reads.values()) {
      const current = await replay.read(prior.input);
      requireStable(prior, current, outputs);
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
    return new PathBindingReplay().run(async () => {
      for (const record of records) {
        const read = () => replayDiscoveryRead(record.descriptor);
        const input = { ...record, value: await read(), read };
        const next = observation(input);
        if (!isSameVersion(record, next)) return false;
        this.#recordObservation(next);
      }
      return true;
    });
  }
  validateSynchronous(records: readonly DiscoveryRecord[]): boolean {
    return new PathBindingReplay().run(() =>
      records.every((record) => this.#validateSynchronousRecord(record)),
    );
  }
}
