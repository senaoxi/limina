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
      name: 'FaultInjectedSecondaryFinalizationError',
    },
    exitCode: 1,
    issues: [],
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
  id: 'fault-injection/finalization-secondary-after-task-failure',
  kind: 'fault-injection',
  secondaryFault: {
    fault: {
      code: 'EFINAL',
      kind: 'throw',
      message: 'controlled secondary execution finalization failure',
      name: 'FaultInjectedSecondaryFinalizationError',
    },
    point: 'execution.finalize',
    task: 'graph:check',
  },
});
