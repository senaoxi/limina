import { normalizeAbsolutePath } from '#utils/path';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type {
  AnalysisCacheMetrics,
  AnalysisInput,
  InputDependency,
  InputKind,
} from './contracts';
import { AnalysisInputDriftError } from './contracts';
import { analysisHash } from './identity';
import { hasChangedBytes, hasMtime, retainedInput } from './input-equality';
import {
  inputStat,
  isRegularFile,
  observedContent,
  readInput,
} from './input-state';
import { manifestField, requiresManifestInvalidation } from './manifest-input';

export class AnalysisInputs {
  #nativeConsumed = false;
  #drift: string | undefined;
  readonly #observations = new Map<string, unknown>();
  readonly #dependencies = new Map<string, InputDependency>();
  readonly #consumed = new Map<string, string>();
  readonly records: Record<string, AnalysisInput> = {};
  domainDirty = false;
  readonly configInputs: Set<string> = new Set<string>();
  readonly previous: Record<string, AnalysisInput>;
  readonly metrics: AnalysisCacheMetrics;
  constructor(
    previous: Record<string, AnalysisInput>,
    metrics: AnalysisCacheMetrics,
  ) {
    this.previous = previous;
    this.metrics = metrics;
  }

  #read(
    path: string,
    kind: InputKind,
    previous?: AnalysisInput,
  ): AnalysisInput {
    const input = ['imports', 'exports'].includes(kind)
      ? this.#field(path, kind as 'imports' | 'exports')
      : this.#readInput(path, kind, previous);
    this.#checkManifest(previous, input);
    this.#checkBytes(previous, input);
    return retainedInput(previous, input);
  }

  #readInput(
    path: string,
    kind: InputKind,
    previous?: AnalysisInput,
  ): AnalysisInput {
    try {
      return readInput({ path, kind, previous, metrics: this.metrics });
    } catch (error) {
      if (error instanceof AnalysisInputDriftError) this.#rejectDrift(path);
      throw error;
    }
  }

  #field(path: string, field: 'imports' | 'exports'): AnalysisInput {
    const content = this.observe(path, 'content');
    return manifestField(this.records[content.inputId], field);
  }

  #checkManifest(
    previous: AnalysisInput | undefined,
    next: AnalysisInput,
  ): void {
    const isManifest =
      next.path.endsWith('/package.json') &&
      ['content', 'file', 'binding'].includes(next.kind);
    if (isManifest) this.#invalidateManifest(previous, next);
  }

  #invalidateManifest(
    previous: AnalysisInput | undefined,
    next: AnalysisInput,
  ): void {
    if (!requiresManifestInvalidation(previous, next)) return;
    this.#assertDomainUnused(next.path);
    this.domainDirty = true;
  }

  #rejectDrift(path: string): never {
    this.#drift = path;
    throw new AnalysisInputDriftError(path);
  }

  #assertDomainUnused(path: string): void {
    if (this.#nativeConsumed && !this.domainDirty) this.#rejectDrift(path);
  }

  #assertConsumed(path: string, id: string, version: string): void {
    const consumed = this.#consumed.get(id);
    if (consumed !== undefined && consumed !== version) this.#rejectDrift(path);
  }

  #refreshFields(path: string): void {
    for (const field of ['imports', 'exports'] as const) {
      const id = JSON.stringify(['physical', field, path]);
      if (this.records[id] === undefined) continue;
      const next = this.#field(path, field);
      this.#assertConsumed(path, id, next.version);
      this.records[id] = retainedInput(this.records[id], next);
    }
  }

  #consume(dependency: InputDependency): void {
    const old = this.#consumed.get(dependency.inputId);
    if (old !== undefined && old !== dependency.expectedVersion)
      this.#rejectDrift(this.records[dependency.inputId].path);
    this.#consumed.set(dependency.inputId, dependency.expectedVersion);
  }

  #observeConfigEntry(entry: { filePath: string; contentHash: string }): void {
    const checkedAt = Date.now();
    const stat = inputStat(entry.filePath);
    const text = readFileSync(entry.filePath, 'utf8');
    if (createHash('sha256').update(text).digest('hex') !== entry.contentHash)
      this.#rejectDrift(entry.filePath);
    const dependency = this.observeText({
      path: entry.filePath,
      text,
      checkedAt,
      beforeMtime: stat!.mtimeMs,
    });
    this.configInputs.add(dependency.inputId);
    this.consume([dependency]);
  }

  #assertConsumedVersions(): void {
    for (const [id, version] of this.#consumed) {
      const input = this.records[id];
      if (input.version !== version)
        throw new AnalysisInputDriftError(input.path);
    }
  }

  #assertInputStable(input: AnalysisInput): void {
    if (['imports', 'exports'].includes(input.kind)) return;
    this.#assertStoredInput(input);
  }

  #assertStoredInput(input: AnalysisInput): void {
    if (['content', 'bytes'].includes(input.kind)) {
      this.#assertContentStable(input);
      return;
    }
    const current = readInput({
      path: input.path,
      kind: input.kind,
      metrics: this.metrics,
    });
    if (current.version !== input.version)
      throw new AnalysisInputDriftError(input.path);
  }

  #assertContentStable(input: AnalysisInput): void {
    const current = inputStat(input.path);
    const observed = isRegularFile(current) ? current.mtimeMs : undefined;
    if (observed !== input.observedMtime)
      throw new AnalysisInputDriftError(input.path);
  }

  #checkBytes(previous: AnalysisInput | undefined, input: AnalysisInput): void {
    if (hasChangedBytes(previous, input)) this.invalidateDomain(input.path);
  }

  #dependency(inputId: string, expectedVersion: string): InputDependency {
    const key = `${inputId}:${expectedVersion}`;
    const prior = this.#dependencies.get(key);
    if (prior !== undefined) return prior;
    const value = Object.freeze({ inputId, expectedVersion });
    this.#dependencies.set(key, value);
    return value;
  }
  observe(filePath: string, kind: InputKind): InputDependency {
    const path = normalizeAbsolutePath(filePath);
    const inputId = JSON.stringify(['physical', kind, path]);
    this.records[inputId] ??= this.#read(path, kind, this.previous[inputId]);
    return this.#dependency(inputId, this.records[inputId].version);
  }

  observeText(options: {
    path: string;
    text: string;
    checkedAt: number;
    beforeMtime: number;
  }): InputDependency {
    const path = normalizeAbsolutePath(options.path);
    const inputId = JSON.stringify(['physical', 'content', path]);
    const next = observedContent({
      ...options,
      path,
      metrics: this.metrics,
    });
    if (next.verifiedThrough === undefined) this.#rejectDrift(path);
    this.#assertConsumed(path, inputId, next.version);
    this.#checkManifest(this.previous[inputId], next);
    const prior = this.records[inputId] ?? this.previous[inputId];
    this.records[inputId] = retainedInput(prior, next);
    this.#refreshFields(path);
    return this.#dependency(inputId, next.version);
  }

  observeBytes(options: {
    path: string;
    bytes: Buffer;
    beforeMtime: number;
  }): InputDependency {
    const path = normalizeAbsolutePath(options.path);
    if (!hasMtime(path, options.beforeMtime)) this.#rejectDrift(path);
    const version = createHash('sha256').update(options.bytes).digest('hex');
    const inputId = JSON.stringify(['physical', 'bytes', path]);
    this.#assertConsumed(path, inputId, version);
    const next: AnalysisInput = {
      path,
      kind: 'bytes',
      version,
      observedMtime: options.beforeMtime,
      verifiedThrough: Math.min(Date.now(), options.beforeMtime),
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

  invalidateDomain(path: string): void {
    this.#assertDomainUnused(path);
    this.domainDirty = true;
  }

  consume(dependencies: readonly InputDependency[]): void {
    for (const dependency of dependencies) this.#consume(dependency);
  }

  observeConfig(
    closure: readonly { filePath: string; contentHash: string }[],
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
    for (const input of Object.values(this.previous))
      this.observe(input.path, input.kind);
  }

  assertStable(): void {
    if (this.#drift !== undefined)
      throw new AnalysisInputDriftError(this.#drift);
    this.#assertConsumedVersions();
    for (const input of Object.values(this.records))
      this.#assertInputStable(input);
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
