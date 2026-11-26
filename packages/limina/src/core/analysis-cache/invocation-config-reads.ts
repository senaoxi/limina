import {
  type ResolvedConfigCacheRequest,
  withLiveConfigParser,
} from '#utils/resolved-config-cache';
import { withSourceConfigTextScope } from '#utils/source-config-text';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ResolvedConfigProjection } from '../../checker/resolved-config';
import type { AnalysisCacheMetrics } from './contracts';
import { EpochInputReplay, EpochInputs } from './epoch-inputs';
import { recordCacheHit } from './profile-decisions';
import type { SourceConfigProjectionCache } from './source-config-projection';

export class InvocationConfigReads {
  readonly #rounds = new AsyncLocalStorage<EpochInputReplay>();
  readonly #metrics: AnalysisCacheMetrics;
  readonly #projections: SourceConfigProjectionCache | undefined;

  constructor(
    metrics: AnalysisCacheMetrics,
    projections?: SourceConfigProjectionCache,
  ) {
    this.#metrics = metrics;
    this.#projections = projections;
  }

  #capture(
    request: ResolvedConfigCacheRequest | undefined,
    value: unknown,
    reads: EpochInputs,
  ): boolean {
    return (
      request !== undefined &&
      (this.#projections?.capture(
        request,
        value as ResolvedConfigProjection,
        reads,
      ) ??
        false)
    );
  }

  replay(): EpochInputReplay {
    return this.#rounds.getStore() ?? new EpochInputReplay();
  }

  run<T>(operation: () => T): T {
    if (this.#rounds.getStore() !== undefined) return operation();
    const parsed = new Map<
      string,
      {
        value: unknown;
        reads: EpochInputs;
        hasCapturedProjection: boolean;
        layer: 'resolved-config-live-parse' | 'resolved-config-projection';
      }
    >();
    const runParser = () =>
      withLiveConfigParser((parse, key, request) => {
        const current = key === undefined ? undefined : parsed.get(key);
        if (current !== undefined) {
          current.reads.publish();
          current.hasCapturedProjection ||= this.#capture(
            request,
            current.value,
            current.reads,
          );
          recordCacheHit(current.layer, 'invocation-memory');
          return current.value as ReturnType<typeof parse>;
        }
        if (request !== undefined && key !== undefined) {
          const restored = this.#projections?.restore(request);
          if (restored !== undefined) {
            restored.reads.publish();
            parsed.set(key, {
              ...restored,
              hasCapturedProjection: true,
              layer: 'resolved-config-projection',
            });
            this.#metrics.resolvedConfigProjectionHits++;
            return restored.value as ReturnType<typeof parse>;
          }
        }
        this.#metrics.resolvedConfigParses++;
        if (key === undefined) return parse();
        const reads = new EpochInputs();
        const value = reads.collect(parse);
        const hasCapturedProjection = this.#capture(request, value, reads);
        parsed.set(key, {
          value,
          reads,
          hasCapturedProjection,
          layer: 'resolved-config-live-parse',
        });
        return value;
      }, operation);
    return this.#rounds.run(new EpochInputReplay(), () =>
      withSourceConfigTextScope(runParser),
    );
  }
}
