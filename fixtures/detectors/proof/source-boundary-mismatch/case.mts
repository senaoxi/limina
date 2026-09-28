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
        code: LIMINA_CHECK_ISSUE_CODES.proofSourceBoundaryMismatch,
        evidence: [
          {
            label: 'diagnostic',
            lines: ['  - packages/pkg/fixtures/covered.ts'],
          },
        ],
        locations: [
          {
            filePath: 'packages/pkg/fixtures/covered.ts',
            label: 'source or covering project',
          },
        ],
        task: 'proof:check',
      },
    ],
    primaryCode: LIMINA_CHECK_ISSUE_CODES.proofSourceBoundaryMismatch,
  },
  id: 'proof/source-boundary-mismatch',
  kind: 'filesystem',
  setup: [],
  tools: ['typescript'],
});
