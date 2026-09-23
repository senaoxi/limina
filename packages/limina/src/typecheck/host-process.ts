import type { ChildProcess } from 'node:child_process';
import {
  type CheckerHostRequest,
  type CheckerHostResponse,
  spawnAndMeasure,
} from './host-protocol';
import {
  terminateChildProcessTree,
  waitForChildProcessTreeTermination,
} from './process-tree';

// The idle timeout must comfortably exceed the longest synchronous stretch on
// the parent's main thread, because a blocked parent cannot ping. The host
// therefore never exits while checker children are pending — a silent parent
// with pending work is indistinguishable from a busy one.
const PARENT_LIVENESS_TIMEOUT_MS = 30_000;
const PARENT_LIVENESS_CHECK_INTERVAL_MS = 5000;

const liveCheckerChildren = new Set<ChildProcess>();
const checkerChildrenByRequestId = new Map<number, ChildProcess>();
let pendingSpawnCount = 0;
let lastParentSignalAt = Date.now();

let exitPending = false;

async function exitWithCheckerCleanup(): Promise<void> {
  if (exitPending) return;
  exitPending = true;
  const runningChildren = [...liveCheckerChildren];
  for (const child of runningChildren) terminateChildProcessTree(child);
  await Promise.all(runningChildren.map(waitForChildProcessTreeTermination));

  // eslint-disable-next-line unicorn/no-process-exit -- Dedicated host process entry: exiting after checker cleanup is its lifecycle contract.
  process.exit(0);
}

function scheduleCheckerCleanup(): void {
  exitWithCheckerCleanup().catch(() => {
    process.exitCode = 1;
  });
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
    scheduleCheckerCleanup();
  }
}

type CancelRequest = Extract<CheckerHostRequest, { type: 'cancel' }>;
type SpawnRequest = Extract<CheckerHostRequest, { type: 'spawn' }>;

function cancelChecker(request: CancelRequest): void {
  const child = checkerChildrenByRequestId.get(request.id);
  if (child !== undefined) terminateChildProcessTree(child);
}

function forgetCheckerChild(id: number): void {
  const child = checkerChildrenByRequestId.get(id);
  if (child !== undefined) liveCheckerChildren.delete(child);
  checkerChildrenByRequestId.delete(id);
}

function spawnChecker(request: SpawnRequest): void {
  if (process.env.LIMINA_CHECKER_HOST_TEST_CRASH === '1') {
    // eslint-disable-next-line unicorn/no-process-exit -- Dedicated host test hook intentionally simulates an abrupt host crash.
    process.exit(1);
  }

  pendingSpawnCount += 1;
  spawnAndMeasure(request, {
    onChild: (child) => {
      liveCheckerChildren.add(child);
      checkerChildrenByRequestId.set(request.id, child);
    },
  }).then((measurement) => {
    forgetCheckerChild(request.id);
    pendingSpawnCount -= 1;
    send({
      durationMs: measurement.durationMs,
      ...(measurement.error ? { errorMessage: measurement.error.message } : {}),
      id: request.id,
      status: measurement.status,
      type: 'result',
    });
  });
}

function handleHostRequest(request: CheckerHostRequest): void {
  lastParentSignalAt = Date.now();
  if (request.type === 'spawn') {
    spawnChecker(request);
    return;
  }
  if (request.type === 'cancel') cancelChecker(request);
}

process.on('message', (request: CheckerHostRequest) => {
  handleHostRequest(request);
});

process.on('disconnect', () => {
  scheduleCheckerCleanup();
});
process.on('SIGTERM', scheduleCheckerCleanup);
process.on('SIGINT', scheduleCheckerCleanup);

// IPC disconnect does not reach this process when the parent dies abruptly
// behind the tsx wrapper used in source mode, so an idle liveness watchdog
// backstops it: a parent that has been silent for the whole timeout while no
// checkers are pending is treated as gone.
setInterval(() => {
  if (
    pendingSpawnCount === 0 &&
    Date.now() - lastParentSignalAt > PARENT_LIVENESS_TIMEOUT_MS
  ) {
    scheduleCheckerCleanup();
  }
}, PARENT_LIVENESS_CHECK_INTERVAL_MS);

send({ type: 'ready' });
