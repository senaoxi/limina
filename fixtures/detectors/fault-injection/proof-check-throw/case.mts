import { defineDetectorFixture } from '../../../../integration/helpers/detector-fixture-types';
import { LIMINA_CHECK_ISSUE_CODES } from '../../../../src/check-reporting/codes';

export default defineDetectorFixture({
  command: ['check', 'fault-injection'],
  expected: {
    exitCode: 1,
    issues: [
      {
        code: LIMINA_CHECK_ISSUE_CODES.proofCheckFailed,
        task: 'proof:check',
      },
    ],
    primaryCode: LIMINA_CHECK_ISSUE_CODES.proofCheckFailed,
    runOutcome: 'failed',
    snapshot: { complete: true, expected: true },
    taskStates: {
      'proof:check': 'failed',
      'workspace:validate': 'passed',
    },
  },
  fault: {
    fault: {
      code: 'EIO',
      kind: 'throw',
      message: 'controlled proof check infrastructure failure',
      name: 'FaultInjectedError',
    },
    point: 'task.execute',
    task: 'proof:check',
  },
  id: 'fault-injection/proof-check-throw',
  kind: 'fault-injection',
});
