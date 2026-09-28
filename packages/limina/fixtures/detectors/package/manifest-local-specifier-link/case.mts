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
              '  dependency: @fixture/dependency',
              '  section: devDependencies',
              '  specifier: link:../dependency',
            ],
          },
        ],
        packageManifestPath: 'package-output/package.json',
        packageName: '@fixture/manifest-local-link',
        task: 'package:check',
      },
    ],
    primaryCode: LIMINA_CHECK_ISSUE_CODES.packageManifestInvalid,
  },
  id: 'package/manifest-local-specifier-link',
  kind: 'filesystem',
  tools: [],
});
