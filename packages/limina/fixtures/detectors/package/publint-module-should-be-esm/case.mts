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
        externalCode: 'MODULE_SHOULD_BE_ESM',
        packageManifestPath: 'package-output/package.json',
        packageName: '@fixture/publint-module-should-be-esm',
        task: 'package:check',
      },
    ],
    primaryCode: LIMINA_CHECK_ISSUE_CODES.packagePublint,
  },
  id: 'package/publint-module-should-be-esm',
  kind: 'external-tool',
  tools: [],
});
