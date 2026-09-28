import { defineDetectorFixture } from '../../../../integration/helpers/detector-fixture-types';
import { LIMINA_CHECK_ISSUE_CODES } from '../../../../src/check-reporting/codes';

export default defineDetectorFixture({
  command: ['check', 'fault-injection'],
  expected: {
    exitCode: 1,
    issues: [
      {
        code: LIMINA_CHECK_ISSUE_CODES.releaseCheckFailed,
        task: 'release:check',
      },
    ],
    primaryCode: LIMINA_CHECK_ISSUE_CODES.releaseCheckFailed,
    runOutcome: 'failed',
    snapshot: { complete: true, expected: true },
    taskStates: {
      'release:check': 'failed',
      'workspace:validate': 'passed',
    },
  },
  fault: {
    fault: {
      code: 'EIO',
      kind: 'throw',
      message: 'controlled release check infrastructure failure',
      name: 'FaultInjectedError',
    },
    point: 'task.execute',
    task: 'release:check',
  },
  id: 'fault-injection/release-check-throw',
  kind: 'fault-injection',
});
