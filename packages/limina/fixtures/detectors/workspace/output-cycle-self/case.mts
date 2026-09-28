import { defineDetectorFixture } from '../../../../integration/helpers/detector-fixture-types';
import { LIMINA_CHECK_ISSUE_CODES } from '../../../../src/check-reporting/codes';

export default defineDetectorFixture({
  command: ['check', 'detector'],
  copyPolicy: {
    excludedNames: [],
    includeBuildInfoFiles: false,
    includeOutputDirectories: false,
  },
  expected: {
    additionalCodes: [],
    exitCode: 1,
    issues: [
      {
        code: LIMINA_CHECK_ISSUE_CODES.workspaceOutputCycle,
        filePath: 'limina.config.mts',
        task: 'workspace:validate',
      },
    ],
    primaryCode: LIMINA_CHECK_ISSUE_CODES.workspaceOutputCycle,
  },
  id: 'workspace/output-cycle-self',
  kind: 'filesystem',
  setup: [],
  tools: [],
});
