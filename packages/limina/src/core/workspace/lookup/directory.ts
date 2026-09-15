import { normalizeAbsolutePath } from '#utils/path';
import type { WorkspaceIndexMetricsRecorder } from '../validated-context';
import type { WorkspaceLookupRegion } from './region';
import { recordLookupMetric } from './shared';

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
    const workspacePackage = classification.package;
    if (
      workspacePackage === null ||
      this.#region.isOutsideGovernedRegion(filePath, classification)
    ) {
      return null;
    }

    return this.#findExactDirectoryItem(workspacePackage.directory);
  }

  #findExactDirectoryItem(directory: string): T | null {
    return this.#itemsByDirectory.get(normalizeAbsolutePath(directory)) ?? null;
  }
}
