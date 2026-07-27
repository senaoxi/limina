import { normalizeAbsolutePath } from '#utils/path';
import type {
  WorkspaceIndexMetricsRecorder,
  WorkspacePathClassification,
} from '../validated-context';
import type { WorkspaceLookupRegion } from './region';
import { findNearestDirectoryItem, recordLookupMetric } from './shared';

function getClassifiedPackageDirectory(
  classification: WorkspacePathClassification,
): string | undefined {
  return classification.package?.directory;
}

export class GovernedDirectoryLookup<T extends { directory: string }> {
  readonly #cache = new Map<string, T | null>();
  readonly #itemsByDirectory: ReadonlyMap<string, T>;
  readonly #kind: string;
  readonly #metrics: WorkspaceIndexMetricsRecorder | undefined;
  readonly #region: WorkspaceLookupRegion;

  constructor(options: {
    itemsByDirectory: ReadonlyMap<string, T>;
    kind: string;
    metrics: WorkspaceIndexMetricsRecorder | undefined;
    region: WorkspaceLookupRegion;
  }) {
    this.#itemsByDirectory = options.itemsByDirectory;
    this.#kind = options.kind;
    this.#metrics = options.metrics;
    this.#region = options.region;
  }

  find(filePath: string): T | null {
    const normalizedPath = normalizeAbsolutePath(filePath);
    if (this.#cache.has(normalizedPath)) {
      return this.#returnCached(normalizedPath);
    }

    const value = this.#findUncached(normalizedPath);
    this.#cache.set(normalizedPath, value);
    recordLookupMetric({
      kind: this.#kind,
      metrics: this.#metrics,
      state: 'miss',
      value,
    });
    return value;
  }

  #returnCached(filePath: string): T | null {
    const value = this.#cache.get(filePath) ?? null;
    recordLookupMetric({
      kind: this.#kind,
      metrics: this.#metrics,
      state: 'hit',
      value,
    });
    return value;
  }

  #findUncached(filePath: string): T | null {
    const classification = this.#region.classifyPath(filePath);
    if (this.#region.isOutsideGovernedRegion(filePath, classification)) {
      return null;
    }

    return this.#findInsideGovernedRegion(filePath, classification);
  }

  #findInsideGovernedRegion(
    filePath: string,
    classification: WorkspacePathClassification,
  ): T | null {
    const packageDirectory = getClassifiedPackageDirectory(classification);
    if (packageDirectory === undefined) {
      return findNearestDirectoryItem(filePath, this.#itemsByDirectory);
    }

    return this.#findExactDirectoryItem(packageDirectory);
  }

  #findExactDirectoryItem(directory: string): T | null {
    return this.#itemsByDirectory.get(normalizeAbsolutePath(directory)) ?? null;
  }
}
