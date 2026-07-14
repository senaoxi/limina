import type { ChildProcess } from 'node:child_process';
import {
  type CheckerHostRequest,
  type CheckerHostResponse,
  spawnAndMeasure,
} from './host-protocol';

// The idle timeout must comfortably exceed the longest synchronous stretch on
// the parent's main thread, because a blocked parent cannot ping. The host
// therefore never exits while checker children are pending — a silent parent
// with pending work is indistinguishable from a busy one.
const PARENT_LIVENESS_TIMEOUT_MS = 30_000;
const PARENT_LIVENESS_CHECK_INTERVAL_MS = 5000;

const liveCheckerChildren = new Set<ChildProcess>();
let pendingSpawnCount = 0;
let lastParentSignalAt = Date.now();

function exitWithCheckerCleanup(): void {
  for (const child of liveCheckerChildren) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
  }

  // eslint-disable-next-line unicorn/no-process-exit -- Dedicated host process entry: exiting after checker cleanup is its lifecycle contract.
  process.exit(0);
}

function send(message: CheckerHostResponse): void {
  if (typeof process.send !== 'function') {
    return;
  }

  try {
    process.send(message);
  } catch {
    // The channel is gone, so the parent is gone: results have no audience
    // and any remaining checker children must not be leaked.
    exitWithCheckerCleanup();
  }
}

process.on('message', (request: CheckerHostRequest) => {
  lastParentSignalAt = Date.now();

  if (request.type !== 'spawn') {
    return;
  }

  if (process.env.LIMINA_CHECKER_HOST_TEST_CRASH === '1') {
    process.exit(1);
  }

  pendingSpawnCount += 1;
  spawnAndMeasure(request, {
    onChild: (child) => {
      liveCheckerChildren.add(child);
      child.on('close', () => {
        liveCheckerChildren.delete(child);
      });
    },
  }).then((measurement) => {
    pendingSpawnCount -= 1;
    send({
      durationMs: measurement.durationMs,
      ...(measurement.error ? { errorMessage: measurement.error.message } : {}),
      id: request.id,
      status: measurement.status,
      type: 'result',
    });
  });
});

process.on('disconnect', () => {
  exitWithCheckerCleanup();
});

// IPC disconnect does not reach this process when the parent dies abruptly
// behind the tsx wrapper used in source mode, so an idle liveness watchdog
// backstops it: a parent that has been silent for the whole timeout while no
// checkers are pending is treated as gone.
setInterval(() => {
  if (
    pendingSpawnCount === 0 &&
    Date.now() - lastParentSignalAt > PARENT_LIVENESS_TIMEOUT_MS
  ) {
    exitWithCheckerCleanup();
  }
}, PARENT_LIVENESS_CHECK_INTERVAL_MS);

send({ type: 'ready' });
