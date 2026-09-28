import { defineDetectorFixture } from '../../../../integration/helpers/detector-fixture-types';

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
      name: 'FaultInjectedCleanupError',
    },
    exitCode: 1,
    issues: [],
    runOutcome: 'passed',
    snapshot: { complete: true, expected: true },
    taskStates: {
      'graph:check': 'passed',
      'workspace:validate': 'passed',
    },
  },
  fault: {
    fault: {
      code: 'ECLEANUP',
      kind: 'throw',
      message: 'controlled cleanup failure after successful execution',
      name: 'FaultInjectedCleanupError',
    },
    point: 'cleanup.execute',
    task: 'graph:check',
  },
  id: 'fault-injection/cleanup-success',
  kind: 'fault-injection',
});
