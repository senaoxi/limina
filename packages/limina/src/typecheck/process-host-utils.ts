import type { ChildProcess } from 'node:child_process';
import type {
  CheckerHostResponse,
  CheckerHostSpawnMeasurement,
} from './host-protocol';

type CheckerHostResult = Extract<CheckerHostResponse, { type: 'result' }>;

export function createCheckerHostMeasurement(
  message: CheckerHostResult,
): CheckerHostSpawnMeasurement {
  const measurement: CheckerHostSpawnMeasurement = {
    durationMs: message.durationMs,
    status: message.status,
  };

  if (message.errorMessage === undefined) {
    return measurement;
  }

  return {
    ...measurement,
    error: new Error(message.errorMessage),
  };
}

export function refChildProcess(child: ChildProcess): void {
  child.ref();

  if (child.channel) {
    child.channel.ref();
  }
}

export function unrefChildProcess(child: ChildProcess): void {
  child.unref();

  if (child.channel) {
    child.channel.unref();
  }
}

export function isChildProcessRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}
