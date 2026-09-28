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
      code: 'EIO',
      expected: true,
      name: 'FaultInjectedFilesystemCloseError',
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
      code: 'EIO',
      kind: 'throw',
      message: 'controlled atomic temp close failure',
      name: 'FaultInjectedFilesystemCloseError',
    },
    point: 'filesystem.close',
    task: 'graph:check',
  },
  id: 'fault-injection/filesystem-close-eio',
  kind: 'fault-injection',
});
