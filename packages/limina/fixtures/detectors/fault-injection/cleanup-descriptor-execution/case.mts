import { defineDetectorFixture } from '../../../../integration/helpers/detector-fixture-types';

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
    error: {
      code: 'EFINAL',
      expected: true,
      name: 'FaultInjectedCleanupDescriptorFinalizationError',
    },
    exitCode: 1,
    issues: [],
    runOutcome: 'passed',
    snapshot: { expected: false },
    stdout: { linesInOrder: ['helper-success'] },
    taskStates: { command: 'passed' },
  },
  fault: {
    fault: {
      code: 'EFINAL',
      kind: 'throw',
      message: 'controlled finalization failure after descriptor cleanup',
      name: 'FaultInjectedCleanupDescriptorFinalizationError',
    },
    point: 'execution.finalize',
    task: 'command',
  },
  id: 'fault-injection/cleanup-descriptor-execution',
  kind: 'fault-injection',
});
