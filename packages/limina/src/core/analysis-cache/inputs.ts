import { configFileStamp } from '#utils/config-file-stamp';
import { digestFile } from '#utils/file-digest';
import { normalizeAbsolutePath } from '#utils/path';
import type {
  AnalysisCacheMetrics,
  AnalysisInput,
  InputDependency,
  InputKind,
} from './contracts';
import { AnalysisInputDriftError } from './contracts';
import { PathBindingReplay } from './directory-fingerprint';
import { analysisHash } from './identity';
import { hasChangedBytes, retainedInput } from './input-equality';
import {
  inputStat,
  isRegularFile,
  observedFile,
  readInput,
} from './input-state';

export class AnalysisInputs {
  #nativeConsumed = false;
  readonly #baseline: { baselineTime: number; generation: string } | undefined;
  readonly #liveConfigTimes: ReadonlyMap<string, number> | undefined;
  readonly #sourceStamps = new Map<string, string>();
  readonly #mtimes = new Map<string, number | undefined>();
  #drift: string | undefined;
  readonly #observations = new Map<string, unknown>();
  readonly #dependencies = new Map<string, InputDependency>();
  readonly #consumed = new Map<string, string>();
  readonly records: Record<string, AnalysisInput> = {};
  toolchainChanged = false;
  needsCheckpoint = false;
  readonly configInputs: Set<string> = new Set<string>();
  readonly previous: Record<string, AnalysisInput>;
  readonly metrics: AnalysisCacheMetrics;
  constructor(
    previous: Record<string, AnalysisInput>,
    metrics: AnalysisCacheMetrics,
    baseline?: { baselineTime: number; generation: string },
    liveConfigTimes?: ReadonlyMap<string, number>,
  ) {
    this.#liveConfigTimes = liveConfigTimes;
    this.#baseline = baseline;
    this.previous = previous;
    this.metrics = metrics;
  }

  #boundPrevious(
    path: string,
    kind: InputKind,
    previous: AnalysisInput | undefined,
  ): AnalysisInput | undefined {
    if (!['content', 'bytes', 'config-mtime', 'affecting-mtime'].includes(kind))
      return previous;
    const binding = this.observe(path, 'binding');
    return this.previous[binding.inputId]?.version === binding.expectedVersion
      ? previous
      : undefined;
  }

  #read(
    path: string,
    kind: InputKind,
    previous?: AnalysisInput,
  ): AnalysisInput {
    const stamp = kind === 'content' ? configFileStamp(path) : undefined;
    const bound = this.#boundPrevious(path, kind, previous);
    const input = this.#readInput(path, kind, bound);
    if (stamp !== undefined) {
      this.#recordSourceStamp(path, stamp);
      if (input !== bound) input.contentStamp = stamp;
    }
    this.#checkBytes(previous, input);
    return retainedInput(previous, input);
  }

  #readInput(
    path: string,
    kind: InputKind,
    previous?: AnalysisInput,
  ): AnalysisInput {
    try {
      return readInput({
        path,
        kind,
        previous,
        metrics: this.metrics,
        baseline: this.#baseline,
        captureTextVersions: kind === 'content',
        observeMtime: (file, mtime) => this.#observeMtime(file, mtime),
      });
    } catch (error) {
      if (error instanceof AnalysisInputDriftError) this.#rejectDrift(path);
      throw error;
    }
  }

  #rejectDrift(path: string): never {
    this.#drift = path;
    throw new AnalysisInputDriftError(path);
  }

  #assertToolchainUnused(path: string): void {
    if (this.#nativeConsumed && !this.toolchainChanged) this.#rejectDrift(path);
  }

  #assertConsumed(path: string, id: string, version: string): void {
    const consumed = this.#consumed.get(id);
    if (consumed !== undefined && consumed !== version) this.#rejectDrift(path);
  }

  #consume(dependency: InputDependency): void {
    const old = this.#consumed.get(dependency.inputId);
    if (old !== undefined && old !== dependency.expectedVersion)
      this.#rejectDrift(this.records[dependency.inputId].path);
    this.#consumed.set(dependency.inputId, dependency.expectedVersion);
  }

  #observeMtime(path: string, mtime: number | undefined): void {
    if (this.#mtimes.has(path) && this.#mtimes.get(path) !== mtime)
      this.#rejectDrift(path);
    this.#mtimes.set(path, mtime);
    if (
      mtime !== undefined &&
      this.#baseline !== undefined &&
      mtime > this.#baseline.baselineTime
    )
      this.needsCheckpoint = true;
  }

  #observeConfigEntry(entry: { filePath: string }): void {
    const binding = this.observe(entry.filePath, 'binding');
    this.configInputs.add(binding.inputId);
    const dependency = this.observe(entry.filePath, 'config-mtime');
    this.configInputs.add(dependency.inputId);
    this.consume([binding, dependency]);
  }

  #assertConsumedVersions(): void {
    for (const [id, version] of this.#consumed) {
      const input = this.records[id];
      if (input.version !== version)
        throw new AnalysisInputDriftError(input.path);
    }
  }

  #assertStoredInput(input: AnalysisInput): void {
    if (
      ['content', 'bytes', 'config-mtime', 'affecting-mtime'].includes(
        input.kind,
      )
    ) {
      this.#assertContentStable(input);
      return;
    }
    const current = readInput({
      path: input.path,
      kind: input.kind,
      previous: input,
      metrics: this.metrics,
    });
    if (current.version !== input.version)
      throw new AnalysisInputDriftError(input.path);
  }

  #assertContentStable(input: AnalysisInput): void {
    const stamp =
      input.kind === 'content' ? this.#sourceStamps.get(input.path) : undefined;
    if (stamp !== undefined) {
      if (stamp !== configFileStamp(input.path))
        throw new AnalysisInputDriftError(input.path);
      return;
    }
    const current = inputStat(input.path);
    const observed = isRegularFile(current) ? current.mtimeMs : undefined;
    if (observed !== this.#mtimes.get(input.path))
      throw new AnalysisInputDriftError(input.path);
  }

  #recordSourceStamp(path: string, stamp: string): void {
    if (stamp !== configFileStamp(path)) this.#rejectDrift(path);
    this.#sourceStamps.set(path, stamp);
  }

  #observeFile(
    options: { bytes: Buffer; beforeMtime: number },
    path: string,
    kind: 'content' | 'bytes',
  ): AnalysisInput {
    try {
      return observedFile({
        ...options,
        path,
        kind,
        captureTextVersions: kind === 'content',
        metrics: this.metrics,
      });
    } catch (error) {
      if (error instanceof AnalysisInputDriftError) this.#rejectDrift(path);
      throw error;
    }
  }

  #checkBytes(previous: AnalysisInput | undefined, input: AnalysisInput): void {
    if (hasChangedBytes(previous, input)) this.invalidateToolchain(input.path);
  }

  #dependency(inputId: string, expectedVersion: string): InputDependency {
    const key = `${inputId}:${expectedVersion}`;
    const prior = this.#dependencies.get(key);
    if (prior !== undefined) return prior;
    const value = Object.freeze({ inputId, expectedVersion });
    this.#dependencies.set(key, value);
    return value;
  }
  sourceDigest(filePath: string): string {
    const file = normalizeAbsolutePath(filePath);
    const dependency = this.observe(file, 'content');
    const stamp = this.#sourceStamps.get(file);
    // The published baseline admits the initial source version. Within this
    // invocation a changed or imprecise physical stamp requires a byte read.
    return stamp !== undefined && stamp === configFileStamp(file)
      ? dependency.expectedVersion
      : digestFile(file).hash;
  }

  sourceTextVersion(
    path: string,
    kind: 'content' | 'typescript-content',
  ): string | undefined {
    const file = normalizeAbsolutePath(path);
    const stamp = this.#sourceStamps.get(file);
    if (stamp === undefined || stamp !== configFileStamp(file))
      return undefined;
    const versions =
      this.records[JSON.stringify(['physical', 'content', file])]?.textVersions;
    if (versions === undefined) return undefined;
    return kind === 'typescript-content'
      ? (versions.typescript ?? versions.utf8)
      : versions.utf8;
  }

  observedMtime(path: string): number | undefined {
    return this.#mtimes.get(normalizeAbsolutePath(path));
  }

  configTimes(): ReadonlyMap<string, number> {
    const times = new Map<string, number>();
    for (const id of this.configInputs) {
      const input = this.records[id];
      if (input.kind !== 'config-mtime') continue;
      const mtime = this.#mtimes.get(input.path);
      if (mtime !== undefined) times.set(input.path, mtime);
    }
    return times;
  }

  configCurrent(closurePaths: readonly string[]): boolean {
    if (
      closurePaths.length === 0 ||
      (this.#baseline === undefined && this.#liveConfigTimes === undefined)
    )
      return false;
    return closurePaths.every((path) => {
      const binding = this.observe(path, 'binding');
      const dependency = this.observe(path, 'config-mtime');
      const normalized = normalizeAbsolutePath(path);
      const mtime = this.#mtimes.get(normalized);
      return (
        mtime !== undefined &&
        (this.#baseline !== undefined ||
          this.#liveConfigTimes?.get(normalized) === mtime) &&
        this.previous[binding.inputId]?.version === binding.expectedVersion &&
        this.previous[dependency.inputId]?.version ===
          dependency.expectedVersion
      );
    });
  }

  observe(filePath: string, kind: InputKind): InputDependency {
    const path = normalizeAbsolutePath(filePath);
    const inputId = JSON.stringify(['physical', kind, path]);
    this.records[inputId] ??= this.#read(path, kind, this.previous[inputId]);
    return this.#dependency(inputId, this.records[inputId].version);
  }

  observeContent(options: {
    path: string;
    bytes: Buffer;
    beforeMtime: number;
    beforeStamp?: string;
  }): InputDependency {
    const path = normalizeAbsolutePath(options.path);
    this.observe(path, 'binding');
    const inputId = JSON.stringify(['physical', 'content', path]);
    const next = this.#observeFile(options, path, 'content');
    if (options.beforeStamp === undefined) this.#sourceStamps.delete(path);
    else {
      this.#recordSourceStamp(path, options.beforeStamp);
      next.contentStamp = options.beforeStamp;
    }
    this.#observeMtime(path, options.beforeMtime);
    this.#assertConsumed(path, inputId, next.version);
    const prior = this.records[inputId] ?? this.previous[inputId];
    this.records[inputId] = retainedInput(prior, next);
    return this.#dependency(inputId, next.version);
  }

  observeBytes(options: {
    path: string;
    bytes: Buffer;
    beforeMtime: number;
  }): InputDependency {
    const path = normalizeAbsolutePath(options.path);
    const { version } = this.#observeFile(options, path, 'bytes');
    return this.adoptBytes(path, version, options.beforeMtime);
  }

  adoptObserved(inputId: string, source: AnalysisInputs): void {
    const observed = source.records[inputId];
    const { path, kind, version } = observed;
    if (
      ['content', 'bytes', 'config-mtime', 'affecting-mtime'].includes(kind)
    ) {
      const binding = source.observe(path, 'binding');
      this.adoptObserved(binding.inputId, source);
      this.#observeMtime(path, source.observedMtime(path));
    }
    const current = this.records[inputId];
    if (current !== undefined && current.version !== version)
      this.#rejectDrift(path);
    this.#assertConsumed(path, inputId, version);
    if (kind === 'content') {
      const stamp = source.#sourceStamps.get(path);
      if (stamp !== undefined) this.#recordSourceStamp(path, stamp);
    }
    this.#checkBytes(this.previous[inputId], observed);
    this.records[inputId] = retainedInput(
      current ?? this.previous[inputId],
      observed,
    );
  }

  adoptBytes(file: string, version: string, mtime: number): InputDependency {
    const path = normalizeAbsolutePath(file);
    this.#observeMtime(path, mtime);
    const inputId = JSON.stringify(['physical', 'bytes', path]);
    this.#assertConsumed(path, inputId, version);
    const next: AnalysisInput = {
      path,
      kind: 'bytes',
      version,
    };
    this.#checkBytes(this.previous[inputId], next);
    const prior = this.records[inputId] ?? this.previous[inputId];
    this.records[inputId] = retainedInput(prior, next);
    return this.#dependency(inputId, version);
  }
  memoizeObservation<T>(key: string, observe: () => T): T {
    if (this.#observations.has(key)) return this.#observations.get(key) as T;
    const value = observe();
    this.#observations.set(key, value);
    return value;
  }
  consumeNative(): void {
    this.#nativeConsumed = true;
  }

  invalidateToolchain(path: string): void {
    this.#assertToolchainUnused(path);
    this.toolchainChanged = true;
  }

  consume(dependencies: readonly InputDependency[]): void {
    for (const dependency of dependencies) this.#consume(dependency);
  }

  observeConfig(
    closure: readonly { filePath: string }[],
    virtualFiles?: ReadonlyMap<string, string>,
  ): void {
    const physical = closure.filter(
      (entry) => !virtualFiles?.has(entry.filePath),
    );
    for (const entry of physical) {
      this.#observeConfigEntry(entry);
    }
  }

  valid(dependency: InputDependency): boolean {
    const current = this.records[dependency.inputId];
    if (current !== undefined)
      return current.version === dependency.expectedVersion;
    const input = this.previous[dependency.inputId];
    return (
      input !== undefined &&
      this.observe(input.path, input.kind).expectedVersion ===
        dependency.expectedVersion
    );
  }

  validatePrevious(): void {
    new PathBindingReplay().run(() => {
      for (const input of Object.values(this.previous))
        this.observe(input.path, input.kind);
    });
  }

  assertStable(managedOutputs?: ReadonlySet<string>): void {
    if (this.#drift !== undefined)
      throw new AnalysisInputDriftError(this.#drift);
    this.#assertConsumedVersions();
    new PathBindingReplay().run(() => {
      for (const input of Object.values(this.records))
        if (!managedOutputs?.has(input.path)) this.#assertStoredInput(input);
    });
  }

  structural(
    filePath: string,
    kind: InputKind,
    value: unknown,
  ): InputDependency {
    const dependency = this.observe(filePath, kind);
    if (dependency.expectedVersion !== analysisHash(value))
      this.#rejectDrift(filePath);
    return dependency;
  }
}
