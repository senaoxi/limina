import { defineDetectorFixture } from '../../../../integration/helpers/detector-fixture-types';
import { LIMINA_CHECK_ISSUE_CODES } from '../../../../src/check-reporting/codes';

export default defineDetectorFixture({
  command: [
    'checker',
    'build',
    'packages/app/tsconfig.json',
    '--preset',
    'tsgo',
  ],
  expected: {
    additionalCodes: [],
    exitCode: 1,
    issues: [
      {
        code: LIMINA_CHECK_ISSUE_CODES.checkerTargetSelectionFailed,
        evidence: [{ label: 'checker diagnostic' }],
        filePath: 'packages/app/tsconfig.json',
        task: 'checker:build',
      },
    ],
    primaryCode: LIMINA_CHECK_ISSUE_CODES.checkerTargetSelectionFailed,
  },
  id: 'checker/target-selection-preset',
  kind: 'filesystem',
  tools: [],
});
