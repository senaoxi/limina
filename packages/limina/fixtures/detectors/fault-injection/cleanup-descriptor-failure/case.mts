import { defineDetectorFixture } from '../../../../integration/helpers/detector-fixture-types';
import { LIMINA_CHECK_ISSUE_CODES } from '../../../../src/check-reporting/codes';

export default defineDetectorFixture({
  command: ['check', 'fault-injection'],
  expected: {
    boundary: {
      cleanupDescriptorCount: 1,
      cleanupDirectoryDescriptorCount: 1,
      cleanupFileDescriptorCount: 0,
      cleanupGenerationCount: 1,
      cleanupResourcesRemoved: 1,
      flowCleanupAttempts: 1,
      flowCleanupCompleted: true,
      flowResourcesClosed: true,
      removedTempFiles: 0,
      tempCleanupAttempts: 0,
      tempCleanupCompleted: false,
    },
    error: { expected: false },
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
      code: 'ECLEANUP',
      kind: 'throw',
      message: 'controlled descriptor cleanup failure',
      name: 'FaultInjectedCleanupDescriptorError',
    },
    point: 'cleanup.execute',
    task: 'command',
  },
  id: 'fault-injection/cleanup-descriptor-failure',
  kind: 'fault-injection',
});
