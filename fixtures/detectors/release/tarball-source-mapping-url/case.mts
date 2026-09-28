import { defineDetectorFixture } from '../../../../integration/helpers/detector-fixture-types';
import { createReleaseOutputFileSetup } from '../../../../integration/helpers/release-fixture-output';
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
            value: 'source-mapping-url',
          },
          {
            label: 'tarball',
            value: 'fixture-release-root-1.0.0.tgz',
          },
          {
            label: 'archive entry',
            value: 'index.js',
          },
        ],
        filePath: 'packages/root/dist/index.js',
        packageManifestPath: 'packages/root/dist/package.json',
        packageName: '@fixture/release-root',
        reason: 'source-mapping-url',
        task: 'release:check',
      },
    ],
    primaryCode: LIMINA_CHECK_ISSUE_CODES.releaseTarballHygiene,
  },
  id: 'release/tarball-source-mapping-url',
  kind: 'filesystem',
  setup: [
    createReleaseOutputFileSetup({
      content: 'export const value = 1;\n//# sourceMappingURL=index.js.map\n',
      fileName: 'index.js',
      overwrite: true,
    }),
  ],
  tools: [],
});
