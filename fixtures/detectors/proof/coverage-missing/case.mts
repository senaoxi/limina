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
        code: LIMINA_CHECK_ISSUE_CODES.proofUncoveredSourceFile,
        filePath: 'packages/pkg/fixtures/uncovered.ts',
        packageName: '@fixture/coverage-missing',
        task: 'proof:check',
      },
    ],
    primaryCode: LIMINA_CHECK_ISSUE_CODES.proofUncoveredSourceFile,
  },
  id: 'proof/coverage-missing',
  kind: 'filesystem',
  setup: [],
  tools: ['typescript'],
});
