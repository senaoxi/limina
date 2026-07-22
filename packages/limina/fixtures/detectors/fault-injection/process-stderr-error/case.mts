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
    stderr: { linesInOrder: ['stderr-one', 'stderr-two'] },
    stdout: { linesInOrder: ['stdout-one', 'stdout-two'] },
    taskStates: { command: 'failed' },
  },
  fault: {
    fault: { code: 'EIO', kind: 'stream-error', stream: 'stderr' },
    occurrence: 2,
    point: 'process.stderr',
    task: 'command',
  },
  id: 'fault-injection/process-stderr-error',
  kind: 'fault-injection',
});
