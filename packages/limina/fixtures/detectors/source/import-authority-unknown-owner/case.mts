import { defineDetectorFixture } from '../../../../integration/helpers/detector-fixture-types';
import { LIMINA_CHECK_ISSUE_CODES } from '../../../../src/check-reporting/codes';

export default defineDetectorFixture({
  command: ['check', 'detector'],
  expected: {
    additionalCodes: [],
    exitCode: 1,
    issues: [
      {
        code: LIMINA_CHECK_ISSUE_CODES.sourceImportAuthorityInvalid,
        packageName: '@fixture/source-import-authority-missing',
        scope:
          'source.importAuthority.allow["@fixture/source-import-authority-missing"]',
        task: 'source:check',
      },
    ],
    primaryCode: LIMINA_CHECK_ISSUE_CODES.sourceImportAuthorityInvalid,
  },
  id: 'source/import-authority-unknown-owner',
  kind: 'filesystem',
  setup: [],
  tools: ['typescript'],
});
