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
        code: LIMINA_CHECK_ISSUE_CODES.proofCheckerCoverageInvalid,
        evidence: [
          {
            label: 'diagnostic',
            lines: [
              'Solution tsconfig declares Limina implicit references:',
              '  field: liminaOptions.implicitRefs',
            ],
          },
        ],
        filePath: 'tsconfig.json',
        task: 'proof:check',
      },
    ],
    primaryCode: LIMINA_CHECK_ISSUE_CODES.proofCheckerCoverageInvalid,
  },
  id: 'proof/checker-source-references',
  kind: 'filesystem',
  setup: [],
  tools: ['typescript'],
});
