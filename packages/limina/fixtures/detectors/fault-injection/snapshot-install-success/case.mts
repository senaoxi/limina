import { defineDetectorFixture } from '../../../../integration/helpers/detector-fixture-types';

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
    error: {
      code: 'EPERM',
      expected: true,
      name: 'FaultInjectedSnapshotInstallError',
    },
    exitCode: 1,
    issues: [],
    runOutcome: 'passed',
    snapshot: { expected: false },
    taskStates: {
      'graph:check': 'passed',
      'workspace:validate': 'passed',
    },
  },
  fault: {
    fault: {
      code: 'EPERM',
      kind: 'throw',
      message: 'controlled snapshot install failure',
      name: 'FaultInjectedSnapshotInstallError',
    },
    point: 'snapshot.install',
    task: 'graph:check',
  },
  id: 'fault-injection/snapshot-install-success',
  kind: 'fault-injection',
});
