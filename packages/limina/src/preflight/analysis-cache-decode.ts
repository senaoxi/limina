import { performance } from 'node:perf_hooks';
import type { AnalysisMetricsRecorder } from '../application/analysis/analysis-run';
import { currentProfile } from '../application/analysis/observability';
import type { AnalysisSnapshot } from '../core/analysis-cache/contracts';
import { cacheCause } from '../core/analysis-cache/profile-decisions';
import {
  parseStoredAnalysisSnapshot,
  qualifyAnalysisSnapshotRoot,
} from '../core/analysis-cache/snapshot-schema';
import {
  type AnalysisBlockReference,
  readAnalysisBlocks,
} from '../core/analysis-cache/snapshot-shards';
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
  decision?: string;
  constructor(options: DecodeOptions) {
    this.#options = options;
  }
  #startMeasurement(): number | undefined {
    return this.#options.metrics === undefined ? undefined : performance.now();
  }

  #record(kind: string, start: number | undefined): void {
    if (start === undefined) return;
    this.#options.metrics?.record({
      name: 'analysis-cache',
      kind,
      durationMs: performance.now() - start,
    });
  }
  #parse(bytes: Buffer | undefined, shouldRestore: boolean): unknown {
    if ([!shouldRestore, bytes === undefined].some(Boolean)) return undefined;
    const start = this.#startMeasurement();
    try {
      return JSON.parse(bytes!.toString('utf8'));
    } catch {
      return undefined;
    } finally {
      this.#record('parse', start);
    }
  }
  #qualify(root: SnapshotRoot | undefined) {
    const configObservation = this.#options.configuration;
    if (configObservation === undefined) return { matched: false };
    const current =
      root === undefined
        ? configObservation.capture()
        : configObservation.snapshot(root.configModules);
    const comparison = compareConfigModules(
      previousModules(root),
      current,
      this.#options.configPath,
    );
    this.#recordComparison(comparison.reason);
    const isMatched = comparison.kind === 'match';
    const profile = currentProfile();
    const decision =
      root === undefined
        ? undefined
        : profile?.decision(
            'config-modules',
            isMatched
              ? { stage: 'admission', outcome: 'admitted' }
              : {
                  stage: 'admission',
                  outcome:
                    comparison.kind === 'unknown' ? 'unavailable' : 'rejected',
                  causes: [{ code: comparison.reason }],
                },
            profile.path(this.#options.configPath),
          );
    return { matched: isMatched, decision };
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
    const start = this.#startMeasurement();
    try {
      return parseStoredAnalysisSnapshot(
        readAnalysisBlocks(value, this.#options.readBlock),
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
    options?: { physicalLookup?: string; skipCode?: string },
  ): AnalysisSnapshot | undefined {
    const value = this.#parse(bytes, shouldRestore);
    const start = this.#startMeasurement();
    const metadata = qualifyAnalysisSnapshotRoot(value, this.#options.identity);
    const root = metadata.kind === 'qualified' ? metadata.root : undefined;
    const modules = this.#qualify(root);
    this.#record('config-modules-gate', start);
    const profile = currentProfile();
    if (!shouldRestore || bytes === undefined) {
      const skipCode = options?.skipCode;
      this.decision = profile?.decision(
        'analysis-snapshot',
        {
          stage: 'admission',
          outcome: 'bypassed',
          causes: [
            skipCode === undefined
              ? cacheCause(options?.physicalLookup, 'no-physical-baseline')
              : { code: skipCode },
          ],
          basis:
            options?.physicalLookup === undefined
              ? undefined
              : [options.physicalLookup],
        },
        profile.path(this.#options.configPath),
      );
      return undefined;
    }
    const reason =
      metadata.kind === 'qualified'
        ? modules.matched
          ? this.#options.configVersion === undefined
            ? { code: 'configuration-version-unknown' }
            : root?.header.configVersion === this.#options.configVersion
              ? undefined
              : { code: 'configuration-version-changed' }
          : cacheCause(modules.decision, 'config-modules-unavailable')
        : { code: value === undefined ? 'invalid-index-json' : metadata.kind };
    if (reason !== undefined) {
      this.decision = profile?.decision(
        'analysis-snapshot',
        {
          stage: 'admission',
          outcome: 'rejected',
          causes: [reason],
          basis:
            options?.physicalLookup === undefined
              ? undefined
              : [options.physicalLookup],
        },
        profile.path(this.#options.configPath),
      );
      return undefined;
    }
    const basis = [options?.physicalLookup, modules.decision].filter(
      (decision): decision is string => decision !== undefined,
    );
    this.decision = profile?.decision(
      'analysis-snapshot',
      { stage: 'admission', outcome: 'admitted', basis },
      profile.path(this.#options.configPath),
    );
    const snapshot = this.#restore(value);
    if (snapshot === undefined)
      this.decision = profile?.decision(
        'analysis-snapshot',
        {
          stage: 'lookup',
          outcome: 'corrupt',
          causes: [{ code: 'fact-blocks-invalid' }],
          basis: this.decision === undefined ? undefined : [this.decision],
        },
        profile.path(this.#options.configPath),
      );
    return snapshot;
  }
}

function previousModules(
  root: SnapshotRoot | undefined,
): SnapshotRoot['configModules'] | undefined {
  return root?.configModules;
}
