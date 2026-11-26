import type { VueProjectSemanticIdentity } from '#checkers';
import type ts from 'typescript';
import { currentProfile } from '../../application/analysis/observability';
import type { NativeAnalysisCache } from '../analysis-cache/native-cache';
import type {
  VueQuery,
  VueQueryKind,
  VueQueryResults,
} from '../analysis-cache/vue-contracts';
import { retainVueExecutionInputs } from '../analysis-cache/vue-execution-inputs';
import type { VueGraphFactReader } from '../analysis-cache/vue-graph-facts';
import type { VueInputTrace } from '../analysis-cache/vue-inputs';
import { observeWork } from '../analysis-profile';
import type { TypeEvidenceMetricsRecorder } from '../type-evidence/cache';
import { VueSemanticContext } from './context-handle';
import { vueProfileConfigPath } from './output-identity';

const processWideVueContextSlot: {
  context: VueSemanticContext | undefined;
  owners: Set<VueSemanticContextManager>;
} = {
  context: undefined,
  owners: new Set(),
};

function disposeProcessWideContext(): void {
  const context = processWideVueContextSlot.context;
  if (context !== undefined) context.dispose();
  processWideVueContextSlot.context = undefined;
  processWideVueContextSlot.owners.clear();
}

function getReusableContext(
  identity: VueProjectSemanticIdentity,
  trace: VueInputTrace | undefined,
): VueSemanticContext | null {
  const active = processWideVueContextSlot.context;
  return active === undefined
    ? null
    : reuseMatchingContext(active, identity, trace);
}
function reuseMatchingContext(
  active: VueSemanticContext,
  identity: VueProjectSemanticIdentity,
  trace: VueInputTrace | undefined,
): VueSemanticContext | null {
  if (
    [active.identity.id !== identity.id, active.analysisTrace !== trace].some(
      Boolean,
    )
  )
    return null;
  active.assertActive();
  return active;
}

function recordProgramCreation(options: {
  elapsedMs: number;
  metrics: TypeEvidenceMetricsRecorder | undefined;
  program: ts.Program;
}): void {
  if (options.metrics === undefined) return;
  options.metrics.record({
    durationMs: Math.max(0, options.elapsedMs),
    name: 'program-create-duration',
    provider: 'vue',
  });
  options.metrics.record({ name: 'vue-program-create', provider: 'vue' });
  options.metrics.record({
    count: options.program.getSourceFiles().length,
    name: 'program-source-file-count',
    provider: 'vue',
  });
}

function isOwnsActiveIdentity(identity: VueProjectSemanticIdentity): boolean {
  const active = processWideVueContextSlot.context;
  return active !== undefined && active.identity.id === identity.id;
}

function releaseManagerOwner(manager: VueSemanticContextManager): void {
  processWideVueContextSlot.owners.delete(manager);
  if (processWideVueContextSlot.owners.size === 0) {
    disposeProcessWideContext();
  }
}

export class VueSemanticContextManager {
  readonly #metrics: TypeEvidenceMetricsRecorder | undefined;

  #disposed = false;

  readonly analysisCache: NativeAnalysisCache | undefined;
  constructor(
    metrics?: TypeEvidenceMetricsRecorder,
    analysisCache?: NativeAnalysisCache,
  ) {
    this.analysisCache = analysisCache;
    this.#metrics = metrics;
  }

  #assertActive(): void {
    if (this.#disposed) {
      throw new Error('Vue semantic context manager was disposed.');
    }
  }

  acquire(identity: VueProjectSemanticIdentity): VueSemanticContext {
    this.#assertActive();
    const trace = this.analysisCache?.vue.trace(identity);
    const reusable = getReusableContext(identity, trace);
    if (reusable !== null) {
      retainVueExecutionInputs(reusable.identity, identity);
      processWideVueContextSlot.owners.add(this);
      return reusable;
    }
    disposeProcessWideContext();
    const observer = currentProfile();
    const project = observer?.project(vueProfileConfigPath(identity));
    const context = observeWork(
      observer,
      'vue-context-create',
      () =>
        new VueSemanticContext(
          identity,
          ({ durationMs, program }) =>
            recordProgramCreation({
              elapsedMs: durationMs,
              metrics: this.#metrics,
              program,
            }),
          trace,
        ),
      project === undefined ? undefined : ['project', project],
    );
    context.profileScope(observer);
    processWideVueContextSlot.context = context;
    processWideVueContextSlot.owners.add(this);
    return context;
  }

  graphFacts(
    identity: VueProjectSemanticIdentity,
  ): VueGraphFactReader | undefined {
    this.#assertActive();
    return this.analysisCache?.vue.graphFacts(identity, () => !this.#disposed);
  }

  query<K extends VueQueryKind>(
    query: VueQuery<K>,
  ): VueQueryResults[K] | undefined {
    this.#assertActive();
    return this.analysisCache === undefined
      ? query.collect()
      : this.analysisCache.vue.query(query);
  }

  release(identity: VueProjectSemanticIdentity): void {
    this.#assertActive();
    if (!isOwnsActiveIdentity(identity)) return;
    releaseManagerOwner(this);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    releaseManagerOwner(this);
  }
}
