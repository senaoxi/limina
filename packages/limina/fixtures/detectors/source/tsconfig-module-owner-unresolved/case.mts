import { defineDetectorFixture } from '../../../../integration/helpers/detector-fixture-types';
import { LIMINA_CHECK_ISSUE_CODES } from '../../../../src/check-reporting/codes';

export default defineDetectorFixture({
  command: ['check', 'detector'],
  expected: {
    additionalCodes: [],
    exitCode: 1,
    issues: [
      {
        code: LIMINA_CHECK_ISSUE_CODES.sourceTsconfigGovernance,
        evidence: [
          {
            label: 'diagnostic',
            lines: ['Tsconfig search cannot determine module owner:'],
          },
        ],
        filePath: 'packages/pkg/tools/build.ts',
        packageName: '<workspace>',
        task: 'source:check',
      },
    ],
    primaryCode: LIMINA_CHECK_ISSUE_CODES.sourceTsconfigGovernance,
  },
  id: 'source/tsconfig-module-owner-unresolved',
  kind: 'filesystem',
  setup: [],
  tools: ['typescript'],
});
