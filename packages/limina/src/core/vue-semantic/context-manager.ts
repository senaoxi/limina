import type { VueProjectSemanticIdentity } from '#checkers';
import type ts from 'typescript';
import type { TypeEvidenceMetricsRecorder } from '../type-evidence/cache';
import { VueSemanticContext } from './context-handle';

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
): VueSemanticContext | null {
  const active = processWideVueContextSlot.context;
  if (active === undefined) return null;
  if (active.identity.id !== identity.id) return null;
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

function ownsActiveIdentity(identity: VueProjectSemanticIdentity): boolean {
  const active = processWideVueContextSlot.context;
  if (active === undefined) return false;
  return active.identity.id === identity.id;
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

  constructor(metrics?: TypeEvidenceMetricsRecorder) {
    this.#metrics = metrics;
  }

  acquire(identity: VueProjectSemanticIdentity): VueSemanticContext {
    this.#assertActive();
    const reusable = getReusableContext(identity);
    if (reusable !== null) {
      processWideVueContextSlot.owners.add(this);
      return reusable;
    }
    disposeProcessWideContext();
    const context = new VueSemanticContext(
      identity,
      ({ durationMs, program }) =>
        recordProgramCreation({
          elapsedMs: durationMs,
          metrics: this.#metrics,
          program,
        }),
    );
    processWideVueContextSlot.context = context;
    processWideVueContextSlot.owners.add(this);
    return context;
  }

  release(identity: VueProjectSemanticIdentity): void {
    this.#assertActive();
    if (!ownsActiveIdentity(identity)) return;
    releaseManagerOwner(this);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    releaseManagerOwner(this);
  }

  #assertActive(): void {
    if (this.#disposed) {
      throw new Error('Vue semantic context manager was disposed.');
    }
  }
}
