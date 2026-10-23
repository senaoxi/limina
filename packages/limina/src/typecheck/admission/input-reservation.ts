import type { ExecutionInputScope } from '../../core/analysis-cache/execution-inputs';

export interface Reservation {
  reads: ExecutionInputScope;
  writes: ReadonlySet<string>;
}

export async function resolveOutputs(
  outputs: ReadonlySet<string> | (() => Promise<ReadonlySet<string>>),
): Promise<ReadonlySet<string>> {
  return typeof outputs === 'function' ? await outputs() : outputs;
}

export function hasConflict(
  active: Reservation,
  pending: Reservation,
): boolean {
  return [
    pending.reads.affectedOutputs(active.writes).size > 0,
    active.reads.affectedOutputs(pending.writes).size > 0,
    !pending.writes.isDisjointFrom(active.writes),
  ].some(Boolean);
}
