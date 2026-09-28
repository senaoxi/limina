import { defineDetectorFixture } from '../../../../integration/helpers/detector-fixture-types';
import { LIMINA_CHECK_ISSUE_CODES } from '../../../../src/check-reporting/codes';

export default defineDetectorFixture({
  command: ['check', 'fault-injection'],
  expected: {
    boundary: {
      flowCleanupAttempts: 1,
      flowCleanupCompleted: true,
      flowResourcesClosed: true,
      removedTempFiles: 1,
      tempCleanupAttempts: 1,
      tempCleanupCompleted: true,
    },
    error: { expected: false },
    exitCode: 1,
    issues: [
      {
        code: LIMINA_CHECK_ISSUE_CODES.graphCheckFailed,
        task: 'graph:check',
      },
    ],
    primaryCode: LIMINA_CHECK_ISSUE_CODES.graphCheckFailed,
    runOutcome: 'failed',
    snapshot: { expected: false },
    taskStates: {
      'graph:check': 'failed',
      'workspace:validate': 'passed',
    },
  },
  fault: {
    fault: {
      code: 'EPRIMARY',
      kind: 'throw',
      message: 'controlled primary execution failure',
      name: 'FaultInjectedPrimaryError',
    },
    point: 'task.execute',
    task: 'graph:check',
  },
  id: 'fault-injection/snapshot-secondary-after-task-failure',
  kind: 'fault-injection',
  secondaryFault: {
    fault: {
      code: 'EIO',
      kind: 'throw',
      message: 'controlled secondary snapshot failure',
      name: 'FaultInjectedSecondarySnapshotError',
    },
    point: 'snapshot.write',
    task: 'graph:check',
  },
});
