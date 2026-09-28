import {
  type CheckerHostResponse,
  type CheckerHostSpawnMeasurement,
  type CheckerHostSpawnSpec,
  createCancelledCheckerMeasurement,
} from './host-protocol';
import { createCheckerHostMeasurement } from './process-host-utils';

export type CheckerHostDegradationListener = (reason: string) => void;

export interface PendingCheckerSpawn {
  cancelledMeasurement?: CheckerHostSpawnMeasurement;
  onDegraded?: CheckerHostDegradationListener;
  removeAbortListener?: () => void;
  resolve: (measurement: CheckerHostSpawnMeasurement) => void;
  signal?: AbortSignal;
  spec: CheckerHostSpawnSpec;
}

export function removePendingAbortListener(entry: PendingCheckerSpawn): void {
  if (entry.removeAbortListener !== undefined) entry.removeAbortListener();
}

export function drainPendingCheckerSpawns(
  pendingById: Map<number, PendingCheckerSpawn>,
): PendingCheckerSpawn[] {
  const pending = [...pendingById.values()];
  pendingById.clear();
  for (const entry of pending) removePendingAbortListener(entry);
  return pending;
}

export function resolvePendingCheckerMeasurement(
  pending: PendingCheckerSpawn,
  message: Extract<CheckerHostResponse, { type: 'result' }>,
): CheckerHostSpawnMeasurement {
  return pending.cancelledMeasurement ?? createCheckerHostMeasurement(message);
}

export function createPendingCheckerSpawn(options: {
  onDegraded: CheckerHostDegradationListener | undefined;
  resolve: (measurement: CheckerHostSpawnMeasurement) => void;
  spec: CheckerHostSpawnSpec;
}): PendingCheckerSpawn {
  return {
    onDegraded: options.onDegraded,
    resolve: options.resolve,
    spec: options.spec,
  };
}

export function cancelPendingCheckerSpawn(options: {
  id: number;
  pendingById: Map<number, PendingCheckerSpawn>;
  sendCancel: () => void;
  signal: AbortSignal;
}): void {
  const pending = options.pendingById.get(options.id);
  if (pending === undefined) return;
  if (pending.cancelledMeasurement !== undefined) return;
  removePendingAbortListener(pending);
  pending.removeAbortListener = undefined;
  pending.cancelledMeasurement = createCancelledCheckerMeasurement(
    options.signal,
  );
  options.sendCancel();
}

export function configurePendingAbort(options: {
  handleAbort: () => void;
  pending: PendingCheckerSpawn;
  signal: AbortSignal | undefined;
}): void {
  if (options.signal === undefined) return;
  options.pending.removeAbortListener = () =>
    options.signal!.removeEventListener('abort', options.handleAbort);
  options.pending.signal = options.signal;
}

export function listenForPendingAbort(options: {
  handleAbort: () => void;
  signal: AbortSignal | undefined;
}): void {
  if (options.signal === undefined) return;
  options.signal.addEventListener('abort', options.handleAbort, { once: true });
  if (options.signal.aborted) options.handleAbort();
}
