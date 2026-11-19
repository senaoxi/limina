import {
  type AnalysisRead,
  deriveAnalysisRead,
  observeAnalysisRead,
  withAdditionalAnalysisReads,
  withAnalysisReads,
} from '#utils/analysis-input';
import { compareCodeUnits } from '#utils/collections';
import { configFileStamp, readStampedConfig } from '#utils/config-file-stamp';
import ts from 'typescript';
import { AnalysisInputDriftError, type DiscoveryRecord } from './contracts';
import { pathBinding, PathBindingReplay } from './directory-fingerprint';
import {
  replayDiscoveryRead,
  replaySynchronousDiscoveryRead,
} from './discovery-reads';
import { analysisHash } from './identity';
import type { AnalysisInputs } from './inputs';
import { isAffectedByOutput, isManagedChange } from './managed-output-reads';

const systemReadFile = ts.sys.readFile;

interface Observation {
  sourceReceipt?: true;
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
  return deriveAnalysisRead(input, captureObservation);
}
function captureObservation(input: AnalysisRead): Observation {
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
  if (isSameVersion(prior, current)) return;
  if (
    outputs === undefined ||
    !isManagedChange(prior.input, current.input.value, outputs)
  )
    throw new AnalysisInputDriftError(prior.input.path);
}

function readConfigObservation(
  record: ReplayRecord,
  read: () => unknown,
  hasCurrentMtimeProof = false,
): Observation {
  const { key, path, descriptor } = record;
  const before = configFileStamp(path);
  if (
    hasCurrentMtimeProof ||
    (before !== undefined && before === record.configStamp)
  ) {
    return {
      version: record.version,
      binding: analysisHash(pathBinding(path)),
      input: {
        path,
        key,
        descriptor,
        configStamp: before,
        read,
        get value() {
          const value = read();
          if (analysisHash(value) !== record.version)
            throw new AnalysisInputDriftError(path);
          return value;
        },
      },
    };
  }
  return observation({
    key,
    path,
    descriptor,
    read,
    ...readStampedConfig(path, read, before),
  });
}

type ReplayRecord = Omit<DiscoveryRecord, 'binding'>;

/**
One read-only validation round; never retain across mutation or launch.
*/
export class EpochInputReplay {
  readonly #reads = new Map<string, Promise<Observation>>();
  readonly #observed = new Map<string, Observation>();
  readonly #bindings = new PathBindingReplay({ reuseLeafBindings: true });

  async #read(input: AnalysisRead): Promise<Observation> {
    const key = JSON.stringify([input.key, input.path, input.descriptor]);
    const value =
      this.#observed.get(key) ??
      (await this.#bindings.run(() => readObservation(input)));
    this.#observed.set(key, value);
    return value;
  }

  source(
    record: Pick<AnalysisRead, 'path' | 'key' | 'descriptor'>,
    inputs?: AnalysisInputs,
  ): Observation | undefined {
    const { path, key, descriptor } = record;
    if (
      inputs === undefined ||
      (descriptor?.kind !== 'source-digest' &&
        descriptor?.kind !== 'content' &&
        descriptor?.kind !== 'typescript-content') ||
      descriptor.path !== path ||
      key !== JSON.stringify([descriptor.kind, path]) ||
      (descriptor.kind === 'typescript-content' &&
        ts.sys.readFile !== systemReadFile)
    )
      return undefined;
    if (descriptor.kind === 'source-digest') {
      const read = () => inputs.sourceDigest(path);
      return this.#bindings.run(() =>
        observation({ path, key, descriptor, read, value: read() }),
      );
    }
    const version = inputs.sourceTextVersion(path, descriptor.kind);
    if (version === undefined) return undefined;
    const binding = this.#bindings.run(() => analysisHash(pathBinding(path)));
    const read = () => replaySynchronousDiscoveryRead(descriptor);
    return {
      sourceReceipt: true,
      version,
      binding,
      input: {
        path,
        key,
        descriptor,
        read,
        get value() {
          const value = read();
          if (analysisHash(value) !== version)
            throw new AnalysisInputDriftError(path);
          return value;
        },
      },
    };
  }

  observe(input: AnalysisRead): Observation {
    const key = JSON.stringify([input.key, input.path, input.descriptor]);
    const previous = this.#observed.get(key);
    if (previous !== undefined) {
      if (previous.version !== analysisHash(observedValue(input)))
        throw new AnalysisInputDriftError(input.path);
      return previous;
    }
    const current = this.#bindings.run(() => observation(input));
    this.#observed.set(key, current);
    return current;
  }

  read(
    input: AnalysisRead,
    version: string,
    currentConfigs?: ReadonlySet<string>,
  ): Promise<Observation> {
    const { descriptor, key: inputKey, path, configStamp } = input;
    if (descriptor?.kind === 'config-text') {
      const record = { key: inputKey, path, descriptor, version, configStamp };
      return Promise.resolve(this.readSynchronous(record, currentConfigs)!);
    }
    const key = JSON.stringify([input.key, input.path, input.descriptor]);
    let current = this.#reads.get(key);
    if (current === undefined) {
      current = this.#read(input);
      this.#reads.set(key, current);
    }
    return current;
  }

  readSynchronous(
    record: ReplayRecord,
    currentConfigs?: ReadonlySet<string>,
  ): Observation | undefined {
    const descriptor = record.descriptor;
    if (descriptor.kind === 'glob') return undefined;
    const key = JSON.stringify([record.key, record.path, descriptor]);
    const previous = this.#observed.get(key);
    if (previous !== undefined) return previous;
    const read = () => replaySynchronousDiscoveryRead(descriptor);
    const current = this.#bindings.run(() =>
      descriptor.kind === 'config-text' && descriptor.path === record.path
        ? readConfigObservation(record, read, currentConfigs?.has(record.path))
        : observation({ ...record, value: read(), read }),
    );
    this.#observed.set(key, current);
    return current;
  }
}
/**
Discovery and runtime observations protect this epoch independently of native reuse.
*/
export class EpochInputs {
  readonly #reads = new Map<string, Observation>();
  readonly #physicalInputs?: AnalysisInputs;
  constructor(inputs?: AnalysisInputs) {
    this.#physicalInputs = inputs;
  }
  #observe(input: AnalysisRead): void {
    this.#recordObservation(observation(input));
  }
  #recordObservation(next: Observation): void {
    const { input } = next;
    if (!isSameObservation(this.#reads.get(input.key), next))
      throw new AnalysisInputDriftError(input.path);
    this.#reads.set(input.key, next);
  }
  #validateSynchronousRecord(
    record: DiscoveryRecord,
    replay: EpochInputReplay,
    currentConfigs?: ReadonlySet<string>,
  ): boolean {
    const next =
      replay.source(record, this.#physicalInputs) ??
      replay.readSynchronous(record, currentConfigs);
    if (next === undefined || !isSameVersion(record, next)) return false;
    this.#recordObservation(next);
    return true;
  }
  bind(input: AnalysisRead, replay: EpochInputReplay): void {
    this.#recordObservation(replay.observe(input));
  }
  run<T>(operation: () => T): T {
    return new PathBindingReplay({ reuseLeafBindings: true }).run(() =>
      withAnalysisReads((input) => this.#observe(input), operation),
    );
  }
  collect<T>(operation: () => T): T {
    return withAdditionalAnalysisReads(
      (input) => this.#observe(input),
      operation,
    );
  }
  // Attach a fully validated receipt to every enclosing analysis scope.
  publish(): void {
    for (const value of this.#reads.values())
      observeAnalysisRead(value.input, { derive: captureObservation, value });
  }
  select(paths: ReadonlySet<string>): EpochInputs {
    const selected = new EpochInputs();
    for (const [key, value] of this.#reads)
      if (paths.has(value.input.path)) selected.#reads.set(key, value);
    return selected;
  }
  selectRecords(records: readonly DiscoveryRecord[]): EpochInputs | undefined {
    const selected = new EpochInputs();
    for (const record of records) {
      const value = this.#reads.get(record.key);
      if (
        value === undefined ||
        value.input.path !== record.path ||
        analysisHash(value.input.descriptor) !==
          analysisHash(record.descriptor) ||
        !isSameVersion(record, value)
      )
        return undefined;
      selected.#reads.set(record.key, value);
    }
    return selected;
  }
  append(inputs: EpochInputs): void {
    for (const [key, value] of inputs.#reads) {
      if (!isSameObservation(this.#reads.get(key), value))
        throw new AnalysisInputDriftError(value.input.path);
      this.#reads.set(key, value);
    }
  }
  *governedSourceInputs(): Iterable<{ path: string; version: string }> {
    for (const { input, version } of this.#reads.values()) {
      const { descriptor, key, path } = input;
      if (
        descriptor?.kind === 'source-digest' &&
        descriptor.path === path &&
        key === JSON.stringify([descriptor.kind, path])
      )
        yield { path, version };
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
      const qualified = prior.sourceReceipt
        ? replay.source(prior.input, this.#physicalInputs)
        : undefined;
      const current =
        qualified ?? (await replay.read(prior.input, prior.version));
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
        ...(input.configStamp !== undefined && {
          configStamp: input.configStamp,
        }),
      });
    }
    return result;
  }
  refreshConfigStamps(records: DiscoveryRecord[]): DiscoveryRecord[] {
    let updated: DiscoveryRecord[] | undefined;
    for (const [index, record] of records.entries()) {
      if (record.descriptor.kind !== 'config-text') continue;
      const validated = this.#reads.get(record.key);
      if (
        validated?.input.descriptor?.kind !== 'config-text' ||
        validated.input.path !== record.path ||
        !isSameVersion(record, validated)
      )
        continue;
      const { configStamp, ...identity } = record;
      const stamp = validated.input.configStamp;
      if (stamp === configStamp) continue;
      updated ??= [...records];
      updated[index] =
        stamp === undefined ? identity : { ...identity, configStamp: stamp };
    }
    return updated ?? records;
  }
  async validate(
    records: readonly DiscoveryRecord[],
    replay: EpochInputReplay = new EpochInputReplay(),
    currentConfigs?: ReadonlySet<string>,
  ): Promise<boolean> {
    for (const record of records) {
      const read = () => replayDiscoveryRead(record.descriptor);
      const next =
        replay.source(record, this.#physicalInputs) ??
        (await replay.read(
          { ...record, value: undefined, read },
          record.version,
          currentConfigs,
        ));
      if (!isSameVersion(record, next)) return false;
      this.#recordObservation(next);
    }
    return true;
  }
  validateSynchronous(
    records: readonly DiscoveryRecord[],
    replay: EpochInputReplay = new EpochInputReplay(),
    currentConfigs?: ReadonlySet<string>,
  ): boolean {
    return records.every((record) =>
      this.#validateSynchronousRecord(record, replay, currentConfigs),
    );
  }
}
