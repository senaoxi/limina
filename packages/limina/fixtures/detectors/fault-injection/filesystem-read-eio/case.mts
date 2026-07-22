import { defineDetectorFixture } from '../../../../integration/helpers/detector-fixture-types';
import { LIMINA_CHECK_ISSUE_CODES } from '../../../../src/check-reporting/codes';

export default defineDetectorFixture({
  command: ['check', 'fault-injection'],
  expected: {
    boundary: {
      flowCleanupAttempts: 1,
      flowCleanupCompleted: true,
      flowResourcesClosed: true,
      removedTempFiles: 0,
      tempCleanupAttempts: 0,
      tempCleanupCompleted: false,
    },
    error: { expected: false },
    exitCode: 1,
    issues: [
      {
        code: LIMINA_CHECK_ISSUE_CODES.workspaceValidationFailed,
        task: 'workspace:validate',
      },
    ],
    primaryCode: LIMINA_CHECK_ISSUE_CODES.workspaceValidationFailed,
    runOutcome: 'blocked',
    snapshot: { complete: true, expected: true },
    taskStates: {
      'graph:check': 'blocked',
      'workspace:validate': 'failed',
    },
  },
  fault: {
    fault: {
      code: 'EIO',
      kind: 'throw',
      message: 'controlled execution input read failure',
      name: 'FaultInjectedFilesystemReadError',
    },
    point: 'filesystem.read',
    task: 'workspace:validate',
  },
  id: 'fault-injection/filesystem-read-eio',
  kind: 'fault-injection',
});
