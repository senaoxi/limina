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
        code: LIMINA_CHECK_ISSUE_CODES.workspaceRegionOverlap,
        evidence: [
          {
            label: 'workspace validation',
            lines: [
              'activated workspace package: packages/overlap',
              'workspace descriptor: packages/overlap/pnpm-workspace.yaml',
            ],
          },
        ],
        filePath: 'packages/overlap/pnpm-workspace.yaml',
        task: 'workspace:validate',
      },
    ],
    primaryCode: LIMINA_CHECK_ISSUE_CODES.workspaceRegionOverlap,
  },
  id: 'workspace/region-overlap',
  kind: 'filesystem',
  setup: [],
  tools: [],
});
