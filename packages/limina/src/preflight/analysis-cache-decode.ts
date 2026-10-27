import { performance } from 'node:perf_hooks';
import type { AnalysisMetricsRecorder } from '../application/analysis/analysis-run';
import type { AnalysisSnapshot } from '../core/analysis-cache/contracts';
import { deferSnapshotGraphs } from '../core/analysis-cache/snapshot-graphs';
import {
  parseAnalysisSnapshot,
  parseAnalysisSnapshotRoot,
  parseGraphRecords,
} from '../core/analysis-cache/snapshot-schema';
import {
  AnalysisBlockReader,
  type AnalysisBlockReference,
} from '../core/analysis-cache/snapshot-shards';
import { hasValidGraphRecords } from '../core/analysis-cache/snapshot-validation';
import { compareConfigModules } from './config-module-comparison';
import type { ConfigObservation } from './config-observation';
interface DecodeOptions {
  identity: string;
  configPath: string;
  configVersion?: string;
  configuration?: ConfigObservation;
  metrics?: AnalysisMetricsRecorder;
  readBlock: (reference: AnalysisBlockReference) => Buffer;
}
type SnapshotRoot = Pick<AnalysisSnapshot, 'header' | 'configModules'>;
export class AnalysisSnapshotDecoder {
  readonly #options: DecodeOptions;
  constructor(options: DecodeOptions) {
    this.#options = options;
  }
  #record(kind: string, start: number): void {
    this.#options.metrics?.record({
      name: 'analysis-cache',
      kind,
      durationMs: performance.now() - start,
    });
  }
  #parse(bytes: Buffer | undefined, shouldRestore: boolean): unknown {
    if ([!shouldRestore, bytes === undefined].some(Boolean)) return undefined;
    const start = performance.now();
    try {
      return JSON.parse(bytes!.toString('utf8'));
    } catch {
      return undefined;
    } finally {
      this.#record('parse', start);
    }
  }
  #qualify(root: SnapshotRoot | undefined): boolean {
    const configObservation = this.#options.configuration;
    if (configObservation === undefined) return false;
    const current = configObservation.snapshot(previousModules(root));
    const comparison = compareConfigModules(
      previousModules(root),
      current,
      this.#options.configPath,
    );
    this.#recordComparison(comparison.reason);
    return comparison.kind === 'match';
  }
  #recordComparison(reason: string): void {
    this.#options.metrics?.record({
      name: 'analysis-cache',
      kind: `config-modules-result-${reason}`,
      count: 1,
    });
  }
  #restore(value: unknown): AnalysisSnapshot | undefined {
    if (this.#options.configVersion === undefined) return undefined;
    const start = performance.now();
    try {
      const blocks = new AnalysisBlockReader(value, this.#options.readBlock);
      const snapshot = parseAnalysisSnapshot(
        blocks.facts(),
        this.#options.identity,
        this.#options.configVersion,
      );
      return snapshot === undefined
        ? undefined
        : deferSnapshotGraphs(snapshot, () => this.#graphs(blocks, snapshot));
    } catch {
      return undefined;
    } finally {
      this.#record('validation', start);
    }
  }
  #graphs(
    blocks: AnalysisBlockReader,
    snapshot: AnalysisSnapshot,
  ): AnalysisSnapshot['graphs'] {
    const start = performance.now();
    try {
      const records = parseGraphRecords(blocks.graphs());
      if (!hasValidGraphRecords(snapshot, records))
        throw new Error('Unbound graph projection.');
      return records;
    } finally {
      this.#record('projection-validation', start);
    }
  }
  decode(
    bytes: Buffer | undefined,
    shouldRestore: boolean,
  ): AnalysisSnapshot | undefined {
    const value = this.#parse(bytes, shouldRestore);
    const start = performance.now();
    const root = parseAnalysisSnapshotRoot(value, this.#options.identity);
    const isQualified = this.#qualify(root);
    this.#record('config-modules-gate', start);
    return [
      isQualified,
      root?.header.configVersion === this.#options.configVersion,
    ].every(Boolean)
      ? this.#restore(value)
      : undefined;
  }
}

function previousModules(
  root: SnapshotRoot | undefined,
): SnapshotRoot['configModules'] | undefined {
  return root?.configModules;
}
