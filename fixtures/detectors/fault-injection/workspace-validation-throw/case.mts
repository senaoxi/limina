import { defineDetectorFixture } from '../../../../integration/helpers/detector-fixture-types';
import { LIMINA_CHECK_ISSUE_CODES } from '../../../../src/check-reporting/codes';

export default defineDetectorFixture({
  command: ['check', 'fault-injection'],
  expected: {
    exitCode: 1,
    issues: [
      {
        code: LIMINA_CHECK_ISSUE_CODES.workspaceValidationFailed,
        task: 'workspace:validate',
      },
    ],
    primaryCode: LIMINA_CHECK_ISSUE_CODES.workspaceValidationFailed,
    runOutcome: 'blocked',
    snapshot: { complete: true, expected: true },
    taskStates: {
      'graph:check': 'blocked',
      'workspace:validate': 'failed',
    },
  },
  fault: {
    fault: {
      code: 'EIO',
      kind: 'throw',
      message: 'controlled workspace validation infrastructure failure',
      name: 'FaultInjectedError',
    },
    point: 'task.execute',
    task: 'workspace:validate',
  },
  id: 'fault-injection/workspace-validation-throw',
  kind: 'fault-injection',
});
