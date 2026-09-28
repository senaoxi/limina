import { defineDetectorFixture } from '../../../../integration/helpers/detector-fixture-types';
import { LIMINA_CHECK_ISSUE_CODES } from '../../../../src/check-reporting/codes';

export default defineDetectorFixture({
  command: ['check', 'fault-injection'],
  expected: {
    exitCode: 1,
    issues: [
      {
        code: LIMINA_CHECK_ISSUE_CODES.graphMaterializeFailed,
        task: 'graph:materialize',
      },
    ],
    primaryCode: LIMINA_CHECK_ISSUE_CODES.graphMaterializeFailed,
    runOutcome: 'blocked',
    snapshot: { complete: true, expected: true },
    taskStates: {
      'checker:build': 'blocked',
      'graph:materialize': 'failed',
      'workspace:validate': 'passed',
    },
  },
  fault: {
    fault: {
      code: 'EIO',
      kind: 'throw',
      message: 'controlled graph materialization infrastructure failure',
      name: 'FaultInjectedError',
    },
    point: 'task.execute',
    task: 'graph:materialize',
  },
  id: 'fault-injection/graph-materialize-throw',
  kind: 'fault-injection',
});
