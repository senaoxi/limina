import { defineDetectorFixture } from '../../../../integration/helpers/detector-fixture-types';
import { LIMINA_CHECK_ISSUE_CODES } from '../../../../src/check-reporting/codes';

export default defineDetectorFixture({
  command: ['check', 'detector'],
  expected: {
    additionalCodes: [],
    exitCode: 1,
    issues: [
      {
        code: LIMINA_CHECK_ISSUE_CODES.packageBoundary,
        evidence: [
          { label: 'import', value: 'index.js imports "#internal"' },
          { label: 'environment', value: 'browser' },
        ],
        filePath: 'package-output/index.js',
        packageManifestPath: 'package-output/package.json',
        packageName: '@fixture/boundary-imports-invalid-target',
        task: 'package:check',
      },
    ],
    primaryCode: LIMINA_CHECK_ISSUE_CODES.packageBoundary,
  },
  id: 'package/boundary-imports-invalid-target',
  kind: 'filesystem',
  tools: [],
});
