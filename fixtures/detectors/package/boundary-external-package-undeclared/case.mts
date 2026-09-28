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
          {
            label: 'import',
            value: 'index.js imports "fixture-external-dependency"',
          },
          { label: 'environment', value: 'browser' },
        ],
        filePath: 'package-output/index.js',
        packageManifestPath: 'package-output/package.json',
        packageName: '@fixture/boundary-external-package-undeclared',
        task: 'package:check',
      },
    ],
    primaryCode: LIMINA_CHECK_ISSUE_CODES.packageBoundary,
  },
  id: 'package/boundary-external-package-undeclared',
  kind: 'filesystem',
  setup: [
    {
      kind: 'directory-link',
      path: 'repo/package-output/node_modules/fixture-external-dependency',
      target: 'repo/vendor/fixture-external-dependency',
    },
  ],
  tools: [],
});
