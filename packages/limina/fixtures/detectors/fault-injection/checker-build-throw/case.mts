import { defineDetectorFixture } from '../../../../integration/helpers/detector-fixture-types';
import { LIMINA_CHECK_ISSUE_CODES } from '../../../../src/check-reporting/codes';

export default defineDetectorFixture({
  command: ['check', 'fault-injection'],
  expected: {
    exitCode: 1,
    issues: [
      {
        code: LIMINA_CHECK_ISSUE_CODES.checkerBuildFailed,
        task: 'checker:build',
      },
    ],
    primaryCode: LIMINA_CHECK_ISSUE_CODES.checkerBuildFailed,
    runOutcome: 'failed',
    snapshot: { complete: true, expected: true },
    taskStates: {
      'checker:build': 'failed',
      'graph:materialize': 'passed',
      'workspace:validate': 'passed',
    },
  },
  fault: {
    fault: {
      code: 'EIO',
      kind: 'throw',
      message: 'controlled checker build infrastructure failure',
      name: 'FaultInjectedError',
    },
    point: 'task.execute',
    task: 'checker:build',
  },
  id: 'fault-injection/checker-build-throw',
  kind: 'fault-injection',
});
