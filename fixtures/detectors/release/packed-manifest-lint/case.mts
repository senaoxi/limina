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
        code: LIMINA_CHECK_ISSUE_CODES.releasePackedManifest,
        evidence: [
          {
            label: 'release reason',
            value: 'manifest-lint-failed',
          },
          {
            label: 'external rule',
            value: 'require-license',
          },
          {
            label: 'lint node',
            value: 'license',
          },
          {
            label: 'packed manifest',
            value: 'fixture-release-root-1.0.0.tgz#package.json',
          },
        ],
        externalCode: 'require-license',
        filePath: 'packages/root/dist/package.json',
        packageManifestPath: 'packages/root/dist/package.json',
        packageName: '@fixture/release-root',
        reason: 'manifest-lint-failed',
        task: 'release:check',
      },
    ],
    primaryCode: LIMINA_CHECK_ISSUE_CODES.releasePackedManifest,
  },
  id: 'release/packed-manifest-lint',
  kind: 'external-tool',
  setup: [createReleaseOutputPackageSetup({ license: false })],
  tools: ['npm-package-json-lint'],
});
