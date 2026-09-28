import { defineDetectorFixture } from '../../../../integration/helpers/detector-fixture-types';

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
    error: {
      code: 'EFINAL',
      expected: true,
      name: 'FaultInjectedFinalizationError',
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
      code: 'EFINAL',
      kind: 'throw',
      message: 'controlled execution finalization failure',
      name: 'FaultInjectedFinalizationError',
    },
    point: 'execution.finalize',
    task: 'graph:check',
  },
  id: 'fault-injection/finalization-success',
  kind: 'fault-injection',
});
