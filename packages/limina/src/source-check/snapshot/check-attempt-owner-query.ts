import { hostname } from 'node:os';
import type { CheckAttemptStarted } from './check-attempt-io';
import type { CheckAttemptQueryResult } from './check-attempt-query-types';

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function localProcessSignalResult(error: unknown): boolean {
  if (hasCode(error, 'ESRCH')) return false;
  if (hasCode(error, 'EPERM')) return true;
  throw error;
}

function isLocalProcessAlive(
  owner: CheckAttemptStarted['owner'],
): boolean | null {
  if (owner.hostname !== hostname()) return null;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return localProcessSignalResult(error);
  }
}

export function getIncompleteAttemptResult(
  started: CheckAttemptStarted,
): CheckAttemptQueryResult {
  const alive = isLocalProcessAlive(started.owner);
  if (alive === true) {
    return {
      message:
        'The latest check attempt is still running; no issue inventory is available.',
      snapshot: null,
      state: 'running',
    };
  }
  if (alive === false) {
    return {
      message:
        'The latest check attempt was interrupted; refusing to return an older issue inventory.',
      snapshot: null,
      state: 'interrupted',
    };
  }
  return {
    message:
      'The latest check attempt is incomplete and its owner cannot be verified; refusing to return an older issue inventory.',
    snapshot: null,
    state: 'incomplete',
  };
}
