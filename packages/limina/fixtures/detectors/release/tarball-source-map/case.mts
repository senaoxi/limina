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
            value: 'source-map-file',
          },
          {
            label: 'tarball',
            value: 'fixture-release-root-1.0.0.tgz',
          },
          {
            label: 'archive entry',
            value: 'index.js.map',
          },
        ],
        filePath: 'packages/root/dist/index.js.map',
        packageManifestPath: 'packages/root/dist/package.json',
        packageName: '@fixture/release-root',
        reason: 'source-map-file',
        task: 'release:check',
      },
    ],
    primaryCode: LIMINA_CHECK_ISSUE_CODES.releaseTarballHygiene,
  },
  id: 'release/tarball-source-map',
  kind: 'filesystem',
  setup: [
    createReleaseOutputFileSetup({
      content: '{}\n',
      fileName: 'index.js.map',
    }),
  ],
  tools: [],
});
