import type { ResolvedCheckerModuleName } from '#checkers';
import type { ImportRecord } from '../import-analysis/records';
import { encodeData } from './data-codec';
import { analysisHash } from './identity';
import { occurrenceKey } from './semantic-state';
import type {
  VueContextRecord,
  VueQueryKind,
  VueQueryResults,
} from './vue-contracts';
import type { VueAnalysisMemo } from './vue-memo';

export function vueQueryKey(kind: VueQueryKind, request: unknown): string {
  return analysisHash(encodeData([kind, request]));
}

export function hasVueOccurrenceResolution(record: ImportRecord): boolean {
  return (
    record.kind !== 'environment-pragma' && record.kind !== 'jsx-import-source'
  );
}

export function vueResolutionRequest(
  record: ImportRecord,
  occurrence: string = occurrenceKey(record),
): readonly unknown[] {
  return [record.filePath, record.line, occurrence];
}

export function vueObservationRequest(
  record: ImportRecord,
  target: ResolvedCheckerModuleName | null,
  occurrence: string = occurrenceKey(record),
): readonly unknown[] {
  const targetIdentity =
    target === null
      ? null
      : [
          target.resolvedFileName,
          target.resolvedBy,
          target.isExternalLibraryImport,
        ];
  return [record.filePath, occurrence, targetIdentity];
}

export interface VueGraphOccurrence {
  resolution: VueQueryResults['resolution'];
  observation?: VueQueryResults['dependency-observation'];
}

export interface VueSupportFileIndex
  extends Pick<ReadonlyMap<string, readonly ImportRecord[]>, 'has' | 'get'> {
  isCurrent(): boolean;
}

export interface VueGraphFactReader {
  occurrence(record: ImportRecord): VueGraphOccurrence | undefined;
  source(file: string): ImportRecord[] | undefined;
  support(): VueSupportFileIndex | undefined;
}

interface BoundOccurrence {
  resolutionKey: string;
  resolutionRecord: VueContextRecord['queries'][string];
  observationKey?: string;
}

/** Wire lookups are bound to the exact compiler occurrence and resolved target.
 * Each graph collection still classifies the current runtime file and owns its outputs. */
export class VueGraphFacts {
  readonly #bindings = new Map<string, BoundOccurrence>();

  readonly #context: VueContextRecord;
  readonly #memo: VueAnalysisMemo;
  readonly #supportKey = vueQueryKey('support-inputs', []);
  readonly #supportFiles = new WeakMap<
    VueQueryResults['support-inputs'],
    ReadonlyMap<string, readonly ImportRecord[]>
  >();

  constructor(context: VueContextRecord, memo: VueAnalysisMemo) {
    this.#context = context;
    this.#memo = memo;
  }

  source(file: string): ImportRecord[] | undefined {
    const key = vueQueryKey('compiler-source', [file]);
    return this.#memo.decode('compiler-source', this.#context.queries[key]);
  }

  support(isCurrent: () => boolean): ReturnType<VueGraphFactReader['support']> {
    const inventory = this.#memo.read(
      'support-inputs',
      this.#context.queries[this.#supportKey],
    );
    if (inventory === undefined) return undefined;
    const files =
      this.#supportFiles.get(inventory) ??
      new Map(inventory.map((input) => [input.filePath, input.records]));
    this.#supportFiles.set(inventory, files);
    return Object.freeze({
      isCurrent,
      has: (file: string) => isCurrent() && files.has(file),
      get: (file: string) =>
        isCurrent() ? structuredClone(files.get(file)) : undefined,
    });
  }

  read(record: ImportRecord): VueGraphOccurrence | undefined {
    if (!hasVueOccurrenceResolution(record)) return undefined;
    const occurrence = occurrenceKey(record);
    const request = vueResolutionRequest(record, occurrence);
    const key = JSON.stringify(request);
    const previous = this.#bindings.get(key);
    const queries = this.#context.queries;
    const resolutionKey =
      previous?.resolutionKey ?? vueQueryKey('resolution', request);
    const resolutionRecord = queries[resolutionKey];
    const resolution = this.#memo.read('resolution', resolutionRecord);
    if (resolution === undefined) return undefined;
    let binding = previous;
    if (
      binding === undefined ||
      binding.resolutionRecord !== resolutionRecord
    ) {
      binding = {
        resolutionKey,
        resolutionRecord,
        observationKey:
          resolution.target === null
            ? undefined
            : vueQueryKey(
                'dependency-observation',
                vueObservationRequest(record, resolution.target, occurrence),
              ),
      };
      this.#bindings.set(key, binding);
    }
    return {
      resolution,
      observation:
        binding.observationKey === undefined
          ? undefined
          : this.#memo.read(
              'dependency-observation',
              queries[binding.observationKey],
            ),
    };
  }
}
