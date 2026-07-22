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
      name: 'FaultInjectedFilesystemRenameError',
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
      message: 'controlled filesystem rename failure',
      name: 'FaultInjectedFilesystemRenameError',
    },
    point: 'filesystem.rename',
    task: 'graph:check',
  },
  id: 'fault-injection/filesystem-rename-eio',
  kind: 'fault-injection',
});
