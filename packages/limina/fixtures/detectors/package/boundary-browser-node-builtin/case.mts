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
          { label: 'import', value: 'index.js imports "node:fs"' },
          { label: 'environment', value: 'browser' },
        ],
        filePath: 'package-output/index.js',
        packageManifestPath: 'package-output/package.json',
        packageName: '@fixture/boundary-browser-node-builtin',
        task: 'package:check',
      },
    ],
    primaryCode: LIMINA_CHECK_ISSUE_CODES.packageBoundary,
  },
  id: 'package/boundary-browser-node-builtin',
  kind: 'filesystem',
  tools: [],
});
