import { defineDetectorFixture } from '../../../../integration/helpers/detector-fixture-types';
import { LIMINA_CHECK_ISSUE_CODES } from '../../../../src/check-reporting/codes';

export default defineDetectorFixture({
  command: ['check', 'fault-injection'],
  expected: {
    exitCode: 1,
    issues: [
      {
        code: LIMINA_CHECK_ISSUE_CODES.checkerTypecheckFailed,
        task: 'checker:typecheck',
      },
    ],
    primaryCode: LIMINA_CHECK_ISSUE_CODES.checkerTypecheckFailed,
    runOutcome: 'failed',
    snapshot: { complete: true, expected: true },
    taskStates: {
      'checker:typecheck': 'failed',
      'graph:materialize': 'passed',
      'workspace:validate': 'passed',
    },
  },
  fault: {
    fault: {
      code: 'EIO',
      kind: 'throw',
      message: 'controlled checker typecheck infrastructure failure',
      name: 'FaultInjectedError',
    },
    point: 'task.execute',
    task: 'checker:typecheck',
  },
  id: 'fault-injection/checker-typecheck-throw',
  kind: 'fault-injection',
});
