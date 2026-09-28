import { defineDetectorFixture } from '../../../../integration/helpers/detector-fixture-types';
import { LIMINA_CHECK_ISSUE_CODES } from '../../../../src/check-reporting/codes';

export default defineDetectorFixture({
  command: ['check', 'fault-injection'],
  expected: {
    boundary: {
      flowCleanupAttempts: 1,
      flowCleanupCompleted: false,
      flowResourcesClosed: true,
      removedTempFiles: 0,
      tempCleanupAttempts: 0,
      tempCleanupCompleted: false,
    },
    error: {
      code: 'ECLEANUP',
      expected: true,
      name: 'FaultInjectedTimeoutCleanupError',
    },
    exitCode: 1,
    issues: [
      {
        code: LIMINA_CHECK_ISSUE_CODES.commandFailed,
        task: 'command',
      },
    ],
    primaryCode: LIMINA_CHECK_ISSUE_CODES.commandFailed,
    runOutcome: 'failed',
    snapshot: { complete: true, expected: true },
    stdout: { linesInOrder: ['helper-waiting'] },
    taskStates: { command: 'failed' },
  },
  fault: {
    fault: { kind: 'timeout' },
    point: 'process.wait',
    task: 'command',
  },
  id: 'fault-injection/timeout-cleanup-secondary',
  kind: 'fault-injection',
  secondaryFault: {
    fault: {
      code: 'ECLEANUP',
      kind: 'throw',
      message: 'controlled cleanup failure after timeout termination',
      name: 'FaultInjectedTimeoutCleanupError',
    },
    point: 'cleanup.execute',
    task: 'command',
  },
});
