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
        code: LIMINA_CHECK_ISSUE_CODES.proofAllowlistInvalid,
        filePath: 'limina.config.mts',
        scope: 'proof.allowlist[0].file',
        task: 'proof:check',
      },
    ],
    primaryCode: LIMINA_CHECK_ISSUE_CODES.proofAllowlistInvalid,
  },
  id: 'proof/allowlist-file-empty',
  kind: 'filesystem',
  setup: [],
  tools: ['typescript'],
});
