import { defineDetectorFixture } from '../../../../integration/helpers/detector-fixture-types';
import { LIMINA_CHECK_ISSUE_CODES } from '../../../../src/check-reporting/codes';

export default defineDetectorFixture({
  command: ['check', 'fault-injection'],
  expected: {
    exitCode: 1,
    issues: [
      {
        code: LIMINA_CHECK_ISSUE_CODES.graphPrepareFailed,
        task: 'graph:prepare',
      },
    ],
    primaryCode: LIMINA_CHECK_ISSUE_CODES.graphPrepareFailed,
    runOutcome: 'failed',
    snapshot: { complete: true, expected: true },
    taskStates: {
      'graph:materialize': 'passed',
      'graph:prepare': 'failed',
      'workspace:validate': 'passed',
    },
  },
  fault: {
    fault: {
      code: 'EIO',
      kind: 'throw',
      message: 'controlled graph prepare infrastructure failure',
      name: 'FaultInjectedError',
    },
    point: 'task.execute',
    task: 'graph:prepare',
  },
  id: 'fault-injection/graph-prepare-throw',
  kind: 'fault-injection',
});
