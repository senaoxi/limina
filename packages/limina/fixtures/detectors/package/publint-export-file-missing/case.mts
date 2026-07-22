import { defineDetectorFixture } from '../../../../integration/helpers/detector-fixture-types';
import { LIMINA_CHECK_ISSUE_CODES } from '../../../../src/check-reporting/codes';

export default defineDetectorFixture({
  command: ['check', 'detector'],
  expected: {
    additionalCodes: [],
    exitCode: 1,
    issues: [
      {
        code: LIMINA_CHECK_ISSUE_CODES.packagePublint,
        externalCode: 'FILE_DOES_NOT_EXIST',
        packageManifestPath: 'package-output/package.json',
        packageName: '@fixture/publint-export-file-missing',
        task: 'package:check',
      },
    ],
    primaryCode: LIMINA_CHECK_ISSUE_CODES.packagePublint,
  },
  id: 'package/publint-export-file-missing',
  kind: 'external-tool',
  tools: [],
});
