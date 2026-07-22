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
    taskStates: { command: 'failed' },
  },
  fault: {
    fault: {
      code: 'ENOENT',
      kind: 'throw',
      message: 'controlled process spawn failure',
      name: 'FaultInjectedSpawnError',
    },
    point: 'process.spawn',
    task: 'command',
  },
  id: 'fault-injection/process-spawn-enoent',
  kind: 'fault-injection',
});
