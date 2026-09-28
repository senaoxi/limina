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
        code: LIMINA_CHECK_ISSUE_CODES.proofDuplicateSourceOwner,
        evidence: [
          {
            label: 'diagnostic',
            lines: [
              '    - packages/pkg/tsconfig.alpha.json',
              '    - packages/pkg/tsconfig.beta.json',
            ],
          },
        ],
        filePath: 'packages/pkg/src/shared.ts',
        packageManifestPath: 'packages/pkg/package.json',
        packageName: '@fixture/proof-duplicate-source-owner',
        task: 'proof:check',
      },
    ],
    primaryCode: LIMINA_CHECK_ISSUE_CODES.proofDuplicateSourceOwner,
  },
  id: 'proof/duplicate-source-owner',
  kind: 'filesystem',
  setup: [],
  tools: ['typescript'],
});
