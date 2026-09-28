import { defineDetectorFixture } from '../../../../integration/helpers/detector-fixture-types';

export default defineDetectorFixture({
  command: ['check', 'fault-injection'],
  expected: {
    exitCode: 0,
    issues: [],
    runOutcome: 'passed',
    snapshot: { complete: true, expected: true },
    stdout: { linesInOrder: ['helper-success'] },
    taskStates: {
      'checker:build': 'passed',
      'graph:materialize': 'passed',
      'workspace:validate': 'passed',
    },
  },
  fault: {
    fault: {
      kind: 'invalid-protocol',
      payload: 'not-a-checker-host-response',
    },
    point: 'process.protocol',
    task: 'checker:build',
  },
  id: 'fault-injection/process-invalid-protocol',
  kind: 'fault-injection',
});
