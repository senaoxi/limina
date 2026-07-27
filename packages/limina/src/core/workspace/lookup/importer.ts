import type { ImporterInfo } from '#core/workspace/actions';
import { normalizeAbsolutePath } from '#utils/path';
import type { WorkspaceIndexMetricsRecorder } from '../validated-context';
import type { WorkspaceLookupRegion } from './region';
import { getAncestorDirectories, recordLookupMetric } from './shared';
import type { IndexedImporter } from './types';

function chooseLowerOrdinal(
  current: IndexedImporter,
  candidate: IndexedImporter,
): IndexedImporter {
  return candidate.originalOrdinal < current.originalOrdinal
    ? candidate
    : current;
}

function selectEarlierImporter(
  current: IndexedImporter | undefined,
  candidate: IndexedImporter | undefined,
): IndexedImporter | undefined {
  if (candidate === undefined) {
    return current;
  }

  return current === undefined
    ? candidate
    : chooseLowerOrdinal(current, candidate);
}

function getSelectedImporter(
  selected: IndexedImporter | undefined,
): ImporterInfo | null {
  return selected === undefined ? null : selected.importer;
}

function isHighestPriorityImporter(
  selected: IndexedImporter | undefined,
): boolean {
  return selected !== undefined && selected.originalOrdinal === 0;
}

export class WorkspaceImporterLookup {
  readonly #cache = new Map<string, ImporterInfo | null>();
  readonly #importerByDirectory = new Map<string, IndexedImporter>();
  readonly #metrics: WorkspaceIndexMetricsRecorder | undefined;
  readonly #region: WorkspaceLookupRegion;

  constructor(options: {
    importers: readonly ImporterInfo[];
    metrics: WorkspaceIndexMetricsRecorder | undefined;
    region: WorkspaceLookupRegion;
  }) {
    this.#metrics = options.metrics;
    this.#region = options.region;
    this.#indexImporters(options.importers);
    options.metrics?.record({
      count: this.#importerByDirectory.size,
      kind: 'importer',
      name: 'workspace-directory-index-entry',
      provider: 'workspace-lookup-index',
    });
  }

  find(filePath: string): ImporterInfo | null {
    const normalizedPath = normalizeAbsolutePath(filePath);
    if (this.#cache.has(normalizedPath)) {
      return this.#returnCached(normalizedPath);
    }

    const importer = this.#region.isOutsideGovernedRegion(normalizedPath)
      ? null
      : this.#findNearestImporter(normalizedPath);
    this.#cache.set(normalizedPath, importer);
    recordLookupMetric({
      kind: 'importer',
      metrics: this.#metrics,
      state: 'miss',
      value: importer,
    });
    return importer;
  }

  #indexImporters(importers: readonly ImporterInfo[]): void {
    for (const [originalOrdinal, importer] of importers.entries()) {
      this.#indexImporter(importer, originalOrdinal);
    }
  }

  #indexImporter(importer: ImporterInfo, originalOrdinal: number): void {
    if (!this.#region.hasActivatedPackage(importer.directory)) {
      return;
    }

    const directory = normalizeAbsolutePath(importer.directory);
    if (!this.#importerByDirectory.has(directory)) {
      this.#importerByDirectory.set(directory, { importer, originalOrdinal });
    }
  }

  #findNearestImporter(filePath: string): ImporterInfo | null {
    let selected: IndexedImporter | undefined;

    for (const directory of getAncestorDirectories(filePath)) {
      this.#recordAncestorVisit();
      selected = selectEarlierImporter(
        selected,
        this.#importerByDirectory.get(directory),
      );
      if (isHighestPriorityImporter(selected)) {
        break;
      }
    }

    return getSelectedImporter(selected);
  }

  #recordAncestorVisit(): void {
    this.#metrics?.record({
      kind: 'importer',
      name: 'workspace-importer-ancestor-visit',
      provider: 'workspace-lookup-index',
    });
  }

  #returnCached(filePath: string): ImporterInfo | null {
    const importer = this.#cache.get(filePath) ?? null;
    recordLookupMetric({
      kind: 'importer',
      metrics: this.#metrics,
      state: 'hit',
      value: importer,
    });
    return importer;
  }
}
