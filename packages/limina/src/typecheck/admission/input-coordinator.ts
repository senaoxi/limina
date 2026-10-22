import { AsyncLocalStorage } from 'node:async_hooks';
import {
  type ExecutionInputScope,
  graphExecutionInputScope,
} from '../../core/analysis-cache/execution-inputs';
import type { GeneratedTsconfigGraphResult } from '../../core/build-graph/types';
import type { LiminaPreflightManager } from '../../preflight';
import type { TypecheckTarget } from '../targets';
import {
  observeManagedOutput,
  protectedInputPaths,
} from './output-observation';
import { collectExecutionReferenceClosure } from './reference-closure';

interface Reservation {
  reads: ExecutionInputScope;
  writes: ReadonlySet<string>;
}
function hasIntersection(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): boolean {
  return !left.isDisjointFrom(right);
}
function hasConflict(active: Reservation, pending: Reservation): boolean {
  return [
    pending.reads.affectedOutputs(active.writes).size > 0,
    active.reads.affectedOutputs(pending.writes).size > 0,
    hasIntersection(pending.writes, active.writes),
  ].some(Boolean);
}
async function isStable(scope: ExecutionInputScope): Promise<boolean> {
  try {
    await scope.assertStable();
    return true;
  } catch {
    return false;
  }
}
/**
Invocation-local reservations coordinate existing input proofs and managed output producers.
*/
export class ExecutionInputCoordinator {
  #graph: GeneratedTsconfigGraphResult;
  readonly #original: GeneratedTsconfigGraphResult;
  readonly #preflight: LiminaPreflightManager;
  #snapshot: string;
  readonly #baselines = new Map<string, ExecutionInputScope>();
  readonly #writes = new Set<string>();
  readonly #outputObservations = new Map<
    string,
    ReturnType<typeof observeManagedOutput>
  >();
  readonly #active = new Map<string, Reservation>();
  #change = Promise.withResolvers<void>();
  #writeBatch = 0;
  #refreshedBatch = 0;
  #refresh: Promise<void> | undefined;
  readonly #reservation = new AsyncLocalStorage<Reservation>();
  constructor(
    preflight: LiminaPreflightManager,
    graph: GeneratedTsconfigGraphResult,
  ) {
    this.#preflight = preflight;
    this.#graph = graph;
    this.#original = graph;
    this.#snapshot = preflight.run.snapshotToken;
  }
  #scope(target: TypecheckTarget, graph = this.#graph): ExecutionInputScope {
    const closure = collectExecutionReferenceClosure(
      graph,
      target,
      this.#preflight.config,
    );
    return graphExecutionInputScope(graph, closure.configs, {
      paths: closure.inputs,
      observations: closure.observations,
    });
  }
  #baseline(target: TypecheckTarget): ExecutionInputScope {
    const scope =
      this.#baselines.get(target.id) ?? this.#scope(target, this.#original);
    this.#baselines.set(target.id, scope);
    return scope;
  }
  #notify(): void {
    const previous = this.#change;
    this.#change = Promise.withResolvers<void>();
    previous.resolve();
  }
  #hasConflict(reservation: Reservation, except?: string): boolean {
    return this.#active
      .entries()
      .some(
        ([id, active]) => id !== except && hasConflict(active, reservation),
      );
  }
  async #refreshOutputs(): Promise<void> {
    while (this.#active.size > 0) await this.#change.promise;
    if (this.#refreshedBatch === this.#writeBatch)
      throw new Error(
        'Managed output handoff could not establish fresh evidence.',
      );
    this.#refreshedBatch = this.#writeBatch;
    this.#graph = (await this.#preflight.refreshAfterManagedOutputs()).graph;
    this.#snapshot = this.#preflight.run.snapshotToken;
  }
  async #refreshOnce(): Promise<void> {
    try {
      await this.#refreshOutputs();
    } finally {
      this.#refresh = undefined;
      this.#notify();
    }
  }
  async #refreshInputs(target: TypecheckTarget): Promise<void> {
    const baseline = this.#baseline(target);
    await baseline.assertStable(this.#writes);
    if (await isStable(this.#scope(target))) return;
    await this.#handoff(target, baseline);
  }
  async #handoff(
    target: TypecheckTarget,
    baseline: ExecutionInputScope,
  ): Promise<void> {
    const affected = baseline.affectedOutputs(this.#writes);
    if (affected.size === 0)
      throw new Error(
        'Necessary execution inputs changed outside managed outputs.',
      );
    await this.#assertOutputObservations(affected);
    this.#refresh ??= this.#refreshOnce();
    await this.#refresh;
    await this.#scope(target).assertStable();
  }
  async #assertOutputObservations(
    affected: ReadonlySet<string>,
  ): Promise<void> {
    for (const file of affected) {
      const input = this.#outputObservations.get(file);
      if (input === undefined)
        throw new Error(`Missing managed output receipt: ${file}`);
      await input.assertStable();
    }
  }
  async #waitForReservation(
    target: TypecheckTarget,
    outputs: ReadonlySet<string> | (() => Promise<ReadonlySet<string>>),
  ): Promise<boolean> {
    const change = this.#change.promise;
    const isReserved = await this.#tryReserve(target, outputs);
    await (isReserved ? undefined : change);
    return isReserved;
  }
  async #tryReserve(
    target: TypecheckTarget,
    outputs: ReadonlySet<string> | (() => Promise<ReadonlySet<string>>),
  ): Promise<boolean> {
    if (!this.#canReserve(target)) return false;
    const view = this.#graph;
    await this.#refreshInputs(target);
    return this.#resumeReservation(target, outputs, view);
  }
  #resumeReservation(
    target: TypecheckTarget,
    outputs: ReadonlySet<string> | (() => Promise<ReadonlySet<string>>),
    view: GeneratedTsconfigGraphResult,
  ): Promise<boolean> {
    if (this.#refresh !== undefined) return Promise.resolve(false);
    return view === this.#graph
      ? this.#reserveCurrent(target, outputs)
      : this.#tryReserve(target, outputs);
  }
  #canReserve(target: TypecheckTarget): boolean {
    return (
      !this.#isUnavailable(target) &&
      !this.#hasConflict({ reads: this.#baseline(target), writes: new Set() })
    );
  }
  #isUnavailable(target: TypecheckTarget): boolean {
    return this.#refresh !== undefined || this.#active.has(target.id);
  }
  async #reserveCurrent(
    target: TypecheckTarget,
    outputs: ReadonlySet<string> | (() => Promise<ReadonlySet<string>>),
  ): Promise<boolean> {
    const current: Reservation = {
      reads: this.#scope(target),
      writes: new Set(),
    };
    if (this.#hasConflict(current)) return false;
    this.#active.set(target.id, current);
    try {
      current.writes = await resolveOutputs(outputs);
      return this.#finishReservation(target, current);
    } catch (error) {
      this.#release(target.id);
      throw error;
    }
  }
  #finishReservation(target: TypecheckTarget, current: Reservation): boolean {
    if (!this.#hasConflict(current, target.id)) return true;
    this.#release(target.id);
    return false;
  }
  #release(id: string): void {
    this.#active.delete(id);
    this.#notify();
  }

  async #reserve(
    target: TypecheckTarget,
    outputs: ReadonlySet<string> | (() => Promise<ReadonlySet<string>>),
  ): Promise<void> {
    for (;;) {
      await this.#refresh;
      if (await this.#waitForReservation(target, outputs)) return;
    }
  }
  #recordWrites(outputs: ReadonlySet<string>): void {
    const roots = protectedInputPaths(this.#original);
    for (const file of outputs.difference(roots)) {
      this.#writes.add(file);
      this.#outputObservations.set(file, observeManagedOutput(file));
    }
    if (outputs.size > 0) this.#writeBatch += 1;
  }
  #completeWrites(outputs: ReadonlySet<string>, hasWritten: boolean): void {
    if (hasWritten) this.#recordWrites(outputs);
  }
  isReserved(target: TypecheckTarget): boolean {
    const active = this.#active.get(target.id);
    return active !== undefined && this.#reservation.getStore() === active;
  }
  get graph(): GeneratedTsconfigGraphResult {
    return this.#graph;
  }
  assertLifecycle(): void {
    if (this.#snapshot !== this.#preflight.run.snapshotToken)
      throw new Error('Execution preflight lifecycle changed.');
  }
  async validate(target: TypecheckTarget): Promise<void> {
    await this.#baseline(target).assertStable(this.#writes);
    await this.#scope(target).assertStable();
  }
  async withManagedWrites<T>(
    target: TypecheckTarget,
    outputs: ReadonlySet<string> | (() => Promise<ReadonlySet<string>>),
    action: (
      recordWrites: () => void,
      releaseAtLaunch: () => void,
    ) => Promise<T>,
  ): Promise<T> {
    await this.#reserve(target, outputs);
    const reservedOutputs = this.#active.get(target.id)!.writes;
    let hasWritten = false;
    try {
      return await this.#reservation.run(this.#active.get(target.id)!, () =>
        action(
          () => {
            hasWritten = true;
          },
          () => {
            this.#active.delete(target.id);
            this.#notify();
          },
        ),
      );
    } finally {
      this.#active.delete(target.id);
      this.#completeWrites(reservedOutputs, hasWritten);
      this.#notify();
    }
  }
}

const coordinators = new WeakMap<
  LiminaPreflightManager,
  ExecutionInputCoordinator
>();
export function executionInputCoordinator(
  preflight: LiminaPreflightManager,
  graph: GeneratedTsconfigGraphResult,
): ExecutionInputCoordinator {
  const previous = coordinators.get(preflight);
  // A preflight owns one invocation, including the interval between publishing
  // a refreshed graph and releasing its reservation barrier.
  if (previous !== undefined) return previous;
  const current = new ExecutionInputCoordinator(preflight, graph);
  coordinators.set(preflight, current);
  return current;
}

async function resolveOutputs(
  outputs: ReadonlySet<string> | (() => Promise<ReadonlySet<string>>),
): Promise<ReadonlySet<string>> {
  return typeof outputs === 'function' ? outputs() : outputs;
}
