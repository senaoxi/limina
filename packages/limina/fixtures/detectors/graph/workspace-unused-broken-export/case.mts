import { defineDetectorFixture } from '../../../../integration/helpers/detector-fixture-types';

export default defineDetectorFixture({
  command: ['check', 'detector'],
  copyPolicy: {
    excludedNames: [],
    includeBuildInfoFiles: false,
    includeOutputDirectories: false,
  },
  expected: { additionalCodes: [], exitCode: 0, issues: [] },
  id: 'graph/workspace-unused-broken-export',
  kind: 'filesystem',
  setup: [],
  tools: ['typescript'],
});
