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
            value: 'output-local-specifier',
          },
          {
            label: 'dependency',
            value: '@fixture/release-dependency',
          },
          {
            label: 'dependency section',
            value: 'dependencies',
          },
          {
            label: 'dependency specifier',
            value: 'catalog:default',
          },
          {
            label: 'package manifest',
          },
        ],
        filePath: 'packages/root/dist/package.json',
        packageManifestPath: 'packages/root/dist/package.json',
        packageName: '@fixture/release-root',
        reason: 'output-local-specifier',
        task: 'release:check',
      },
    ],
    primaryCode: LIMINA_CHECK_ISSUE_CODES.releasePackedManifest,
  },
  id: 'release/packed-output-catalog-specifier',
  kind: 'filesystem',
  setup: [
    createReleaseOutputPackageSetup({
      dependencies: { '@fixture/release-dependency': 'catalog:default' },
    }),
  ],
  tools: [],
});
