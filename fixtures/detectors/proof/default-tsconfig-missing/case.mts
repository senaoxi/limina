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
        code: LIMINA_CHECK_ISSUE_CODES.proofDefaultTsconfigInvalid,
        evidence: [
          {
            label: 'diagnostic',
            lines: [
              'Directory with typecheck environments is missing default tsconfig.json:',
              '  directory: packages/pkg',
            ],
          },
        ],
        filePath: 'packages/pkg/tsconfig.json',
        packageManifestPath: 'packages/pkg/package.json',
        packageName: '@fixture/proof-default-tsconfig-missing',
        task: 'proof:check',
      },
    ],
    primaryCode: LIMINA_CHECK_ISSUE_CODES.proofDefaultTsconfigInvalid,
  },
  id: 'proof/default-tsconfig-missing',
  kind: 'filesystem',
  setup: [],
  tools: ['typescript'],
});
