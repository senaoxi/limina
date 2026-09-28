import type { AnalysisMetricsRecorder } from '../../application/analysis/analysis-run';
import type { ImportRecord } from '../import-analysis/records';
import type { OwnedSyntaxInput } from './syntax-input';

interface SyntaxEntry {
  readonly text: string;
  readonly records: ImportRecord[];
  readonly bytes: number;
}

export interface SyntaxCacheStatistics {
  hit: number;
  miss: number;
  bypass: number;
  eviction: number;
  entries: number;
  estimatedBytes: number;
  peakEstimatedBytes: number;
}

function cloneRecords(records: readonly ImportRecord[]): ImportRecord[] {
  return records.map((record) => ({
    domain: record.domain,
    filePath: record.filePath,
    kind: record.kind,
    line: record.line,
    locator: {
      occurrence: record.locator.occurrence,
      sourceEnd: record.locator.sourceEnd,
      sourceStart: record.locator.sourceStart,
    },
    specifier: record.specifier,
    ...(record.configurationSource === undefined
      ? {}
      : {
          configurationSource: {
            configPath: record.configurationSource.configPath,
            option: record.configurationSource.option,
            resolutionMode: record.configurationSource.resolutionMode,
          },
        }),
  }));
}

function recordBytes(record: ImportRecord): number {
  const strings = [
    record.filePath,
    record.specifier,
    record.kind,
    record.domain,
  ];
  const config = record.configurationSource;
  if (config !== undefined) strings.push(config.configPath, config.option);
  return 256 + strings.reduce((bytes, value) => bytes + 2 * value.length, 0);
}

function entryBytes(
  input: OwnedSyntaxInput,
  records: readonly ImportRecord[],
): number {
  return (
    192 +
    2 * (input.text.length + input.descriptor.length) +
    records.reduce((bytes, record) => bytes + recordBytes(record), 0)
  );
}

function cacheLimits(options: { budget?: number; entryLimit?: number }) {
  return {
    budget: options.budget ?? 96 * 1024 * 1024,
    entryLimit: options.entryLimit ?? 8 * 1024 * 1024,
  };
}

/** Plain syntax only; lifetime is one AnalysisProviderSet, never a generation number. */
export class SourceSyntaxFactsCache {
  readonly #entries = new Map<string, SyntaxEntry>();
  readonly #compilerIds = new WeakMap<OwnedSyntaxInput['compiler'], number>();
  #nextCompilerId = 0;
  readonly #budget: number;
  readonly #entryLimit: number;
  readonly metrics: AnalysisMetricsRecorder | undefined;
  #disposed = false;
  readonly #statistics: SyntaxCacheStatistics = {
    hit: 0,
    miss: 0,
    bypass: 0,
    eviction: 0,
    entries: 0,
    estimatedBytes: 0,
    peakEstimatedBytes: 0,
  };

  constructor(
    options: {
      budget?: number;
      entryLimit?: number;
      metrics?: AnalysisMetricsRecorder;
    } = {},
  ) {
    const limits = cacheLimits(options);
    this.#budget = limits.budget;
    this.#entryLimit = limits.entryLimit;
    this.metrics = options.metrics;
  }

  get statistics(): Readonly<SyntaxCacheStatistics> {
    return { ...this.#statistics, entries: this.#entries.size };
  }

  #key(input: OwnedSyntaxInput): string {
    let id = this.#compilerIds.get(input.compiler);
    if (id === undefined) {
      id = this.#nextCompilerId++;
      this.#compilerIds.set(input.compiler, id);
    }
    return `${id}:${input.descriptor}`;
  }

  #record(kind: 'hit' | 'miss' | 'bypass' | 'eviction'): void {
    this.#statistics[kind]++;
    this.metrics?.record({ name: 'syntax-cache', kind });
  }

  #remove(key: string): void {
    const previous = this.#entries.get(key);
    if (previous === undefined) return;
    this.#statistics.estimatedBytes -= previous.bytes;
    this.metrics?.record({
      name: 'syntax-cache-retained',
      count: 0,
      estimatedBytes: -previous.bytes,
    });
    this.#entries.delete(key);
  }

  get(input: OwnedSyntaxInput): ImportRecord[] | undefined {
    if (this.#disposed) {
      this.#record('bypass');
      return undefined;
    }
    return this.#getEntry(input);
  }

  #getEntry(input: OwnedSyntaxInput): ImportRecord[] | undefined {
    const key = this.#key(input);
    const entry = this.#entries.get(key);
    if (entry?.text !== input.text) {
      this.#remove(key);
      this.#record('miss');
      return undefined;
    }
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    this.#record('hit');
    return cloneRecords(entry.records);
  }

  bypass(): void {
    this.#record('bypass');
  }

  set(input: OwnedSyntaxInput, records: readonly ImportRecord[]): void {
    if (this.#disposed) return;
    const key = this.#key(input);
    this.#remove(key);
    const bytes = entryBytes(input, records);
    if (bytes > Math.min(this.#entryLimit, this.#budget)) {
      this.#record('bypass');
      return;
    }
    this.#makeRoom(bytes);
    this.#entries.set(key, {
      text: input.text,
      records: cloneRecords(records),
      bytes,
    });
    this.#statistics.estimatedBytes += bytes;
    this.#statistics.peakEstimatedBytes = Math.max(
      this.#statistics.peakEstimatedBytes,
      this.#statistics.estimatedBytes,
    );
    this.#recordRetained(bytes);
  }

  #recordRetained(bytes: number): void {
    this.metrics?.record({
      name: 'syntax-cache-retained',
      count: 0,
      estimatedBytes: bytes,
    });
  }

  #makeRoom(bytes: number): void {
    while (this.#statistics.estimatedBytes + bytes > this.#budget) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) return;
      this.#remove(oldest);
      this.#record('eviction');
    }
  }

  dispose(): void {
    this.#disposed = true;
    this.#entries.clear();
    this.metrics?.record({
      name: 'syntax-cache-retained',
      count: 0,
      estimatedBytes: -this.#statistics.estimatedBytes,
    });
    this.#statistics.estimatedBytes = 0;
  }
}
