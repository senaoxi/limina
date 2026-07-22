import { defineDetectorFixture } from '../../../../integration/helpers/detector-fixture-types';
import { LIMINA_CHECK_ISSUE_CODES } from '../../../../src/check-reporting/codes';

export default defineDetectorFixture({
  command: ['check', 'detector'],
  expected: {
    additionalCodes: [],
    exitCode: 1,
    issues: [
      {
        code: LIMINA_CHECK_ISSUE_CODES.packageManifestInvalid,
        evidence: [
          {
            label: 'manifest diagnostic',
            lines: [
              '  field: name',
              '  reason: built package outputs must include a non-empty package name.',
            ],
          },
        ],
        packageManifestPath: 'package-output/package.json',
        task: 'package:check',
      },
    ],
    primaryCode: LIMINA_CHECK_ISSUE_CODES.packageManifestInvalid,
  },
  id: 'package/manifest-name-missing',
  kind: 'filesystem',
  tools: [],
});
