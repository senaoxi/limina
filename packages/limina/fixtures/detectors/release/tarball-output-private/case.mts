import { defineDetectorFixture } from '../../../../integration/helpers/detector-fixture-types';
import { createReleaseOutputPackageSetup } from '../../../../integration/helpers/release-fixture-output';
import { LIMINA_CHECK_ISSUE_CODES } from '../../../../src/check-reporting/codes';

export default defineDetectorFixture({
  command: ['check', 'detector'],
  copyPolicy: {
    excludedNames: [],
    includeBuildInfoFiles: false,
    includeOutputDirectories: true,
  },
  expected: {
    additionalCodes: [],
    exitCode: 1,
    issues: [
      {
        code: LIMINA_CHECK_ISSUE_CODES.releaseTarballHygiene,
        evidence: [
          {
            label: 'release reason',
            value: 'output-private',
          },
          {
            label: 'package manifest',
          },
        ],
        filePath: 'packages/root/dist/package.json',
        packageManifestPath: 'packages/root/dist/package.json',
        packageName: '@fixture/release-root',
        reason: 'output-private',
        task: 'release:check',
      },
    ],
    primaryCode: LIMINA_CHECK_ISSUE_CODES.releaseTarballHygiene,
  },
  id: 'release/tarball-output-private',
  kind: 'filesystem',
  setup: [createReleaseOutputPackageSetup({ private: true })],
  tools: [],
});
