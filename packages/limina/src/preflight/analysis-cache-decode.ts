import { performance } from 'node:perf_hooks';
import type { AnalysisMetricsRecorder } from '../application/analysis/analysis-run';
import type { AnalysisSnapshot } from '../core/analysis-cache/contracts';
import {
  parseAnalysisSnapshot,
  parseAnalysisSnapshotRoot,
} from '../core/analysis-cache/snapshot-schema';
import { compareConfigModules } from './config-module-comparison';
import type { ConfigObservation } from './config-observation';
interface DecodeOptions {
  identity: string;
  configPath: string;
  configVersion?: string;
  configuration?: ConfigObservation;
  metrics?: AnalysisMetricsRecorder;
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
      return parseAnalysisSnapshot(
        value,
        this.#options.identity,
        this.#options.configVersion,
      );
    } catch {
      return undefined;
    } finally {
      this.#record('validation', start);
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
    return isQualified ? this.#restore(value) : undefined;
  }
}

function previousModules(
  root: SnapshotRoot | undefined,
): SnapshotRoot['configModules'] | undefined {
  return root?.configModules;
}
