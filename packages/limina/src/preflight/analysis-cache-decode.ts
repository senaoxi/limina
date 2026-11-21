import { performance } from 'node:perf_hooks';
import type { AnalysisMetricsRecorder } from '../application/analysis/analysis-run';
import { currentProfile } from '../application/analysis/observability';
import type { AnalysisSnapshot } from '../core/analysis-cache/contracts';
import { cacheCause } from '../core/analysis-cache/profile-decisions';
import { deferSnapshotGraphs } from '../core/analysis-cache/snapshot-graphs';
import {
  parseAnalysisSnapshot,
  parseGraphRecords,
  qualifyAnalysisSnapshotRoot,
} from '../core/analysis-cache/snapshot-schema';
import {
  AnalysisBlockReader,
  type AnalysisBlockReference,
} from '../core/analysis-cache/snapshot-shards';
import { hasValidGraphRecords } from '../core/analysis-cache/snapshot-validation';
import { compareConfigModules } from './config-module-comparison';
import type { ConfigObservation } from './config-observation';
interface DecodeOptions {
  admit?: (header: AnalysisSnapshot['header'] | undefined) => {
    admitted: boolean;
    decision?: string;
  };
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
    } catch (error) {
      const profile = currentProfile();
      profile?.decision(
        'analysis-graph',
        {
          stage: 'lookup',
          outcome: 'corrupt',
          causes: [{ code: 'graph-projection-invalid' }],
        },
        profile.path(this.#options.configPath),
      );
      throw error;
    } finally {
      this.#record('projection-validation', start);
    }
  }
  decode(
    bytes: Buffer | undefined,
    shouldRestore: boolean,
    options?: { physicalLookup?: string; skipCode?: string },
  ): AnalysisSnapshot | undefined {
    const value = this.#parse(bytes, shouldRestore);
    const start = performance.now();
    const metadata = qualifyAnalysisSnapshotRoot(value, this.#options.identity);
    const root = metadata.kind === 'qualified' ? metadata.root : undefined;
    const lock = this.#options.admit?.(root?.header) ?? { admitted: true };
    const modules = this.#qualify(lock.admitted ? root : undefined);
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
        ? lock.admitted
          ? modules.matched
            ? this.#options.configVersion === undefined
              ? { code: 'configuration-version-unknown' }
              : root?.header.configVersion === this.#options.configVersion
                ? undefined
                : { code: 'configuration-version-changed' }
            : cacheCause(modules.decision, 'config-modules-unavailable')
          : cacheCause(lock.decision, 'installation-rejected')
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
    const basis = [
      options?.physicalLookup,
      lock.decision,
      modules.decision,
    ].filter((decision): decision is string => decision !== undefined);
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
