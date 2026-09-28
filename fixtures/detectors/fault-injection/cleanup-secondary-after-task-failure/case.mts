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
      name: 'FaultInjectedSecondaryCleanupError',
    },
    exitCode: 1,
    issues: [
      {
        code: LIMINA_CHECK_ISSUE_CODES.graphCheckFailed,
        task: 'graph:check',
      },
    ],
    primaryCode: LIMINA_CHECK_ISSUE_CODES.graphCheckFailed,
    runOutcome: 'failed',
    snapshot: { complete: true, expected: true },
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
  id: 'fault-injection/cleanup-secondary-after-task-failure',
  kind: 'fault-injection',
  secondaryFault: {
    fault: {
      code: 'ECLEANUP',
      kind: 'throw',
      message: 'controlled secondary cleanup failure',
      name: 'FaultInjectedSecondaryCleanupError',
    },
    point: 'cleanup.execute',
    task: 'graph:check',
  },
});
