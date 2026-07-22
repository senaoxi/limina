import { defineDetectorFixture } from '../../../../integration/helpers/detector-fixture-types';
import { LIMINA_CHECK_ISSUE_CODES } from '../../../../src/check-reporting/codes';

export default defineDetectorFixture({
  command: ['check', 'fault-injection'],
  expected: {
    exitCode: 1,
    issues: [
      {
        code: LIMINA_CHECK_ISSUE_CODES.commandFailed,
        evidence: [{ label: 'command' }, { label: 'exit code', value: '1' }],
        task: 'command',
      },
    ],
    primaryCode: LIMINA_CHECK_ISSUE_CODES.commandFailed,
    runOutcome: 'failed',
    snapshot: { complete: true, expected: true },
    taskStates: { command: 'failed' },
  },
  fault: {
    fault: { kind: 'process-signal', signal: 'SIGTERM' },
    point: 'process.wait',
    task: 'command',
  },
  id: 'fault-injection/process-signal-termination',
  kind: 'fault-injection',
});
