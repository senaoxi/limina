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
        externalCode: 'cjs-resolves-to-esm',
        packageManifestPath: 'package-output/package.json',
        packageName: '@fixture/attw-cjs-resolves-to-esm',
        task: 'package:check',
      },
    ],
    primaryCode: LIMINA_CHECK_ISSUE_CODES.packageAttw,
  },
  id: 'package/attw-cjs-resolves-to-esm',
  kind: 'external-tool',
  tools: [],
});
