import { defineDetectorFixture } from '../../../../integration/helpers/detector-fixture-types';
import { LIMINA_CHECK_ISSUE_CODES } from '../../../../src/check-reporting/codes';

export default defineDetectorFixture({
  command: ['check', 'detector'],
  expected: {
    additionalCodes: [],
    exitCode: 1,
    issues: [
      {
        code: LIMINA_CHECK_ISSUE_CODES.packageAttw,
        externalCode: 'false-export-default',
        packageManifestPath: 'package-output/package.json',
        packageName: '@fixture/attw-false-export-default',
        task: 'package:check',
      },
    ],
    primaryCode: LIMINA_CHECK_ISSUE_CODES.packageAttw,
  },
  id: 'package/attw-false-export-default',
  kind: 'external-tool',
  tools: [],
});
