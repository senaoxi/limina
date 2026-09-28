import { defineDetectorFixture } from '../../../../integration/helpers/detector-fixture-types';
import { LIMINA_CHECK_ISSUE_CODES } from '../../../../src/check-reporting/codes';

export default defineDetectorFixture({
  command: ['check', 'fault-injection'],
  expected: {
    exitCode: 1,
    issues: [
      {
        code: LIMINA_CHECK_ISSUE_CODES.commandFailed,
        task: 'command',
      },
    ],
    primaryCode: LIMINA_CHECK_ISSUE_CODES.commandFailed,
    runOutcome: 'failed',
    snapshot: { complete: true, expected: true },
    stdout: { linesInOrder: ['helper-waiting'] },
    taskStates: { command: 'failed' },
  },
  fault: {
    fault: { kind: 'timeout' },
    point: 'process.wait',
    task: 'command',
  },
  id: 'fault-injection/process-timeout',
  kind: 'fault-injection',
});
