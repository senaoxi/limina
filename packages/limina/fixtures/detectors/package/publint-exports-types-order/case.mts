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
        externalCode: 'EXPORTS_TYPES_SHOULD_BE_FIRST',
        packageManifestPath: 'package-output/package.json',
        packageName: '@fixture/publint-exports-types-order',
        task: 'package:check',
      },
    ],
    primaryCode: LIMINA_CHECK_ISSUE_CODES.packagePublint,
  },
  id: 'package/publint-exports-types-order',
  kind: 'external-tool',
  tools: [],
});
