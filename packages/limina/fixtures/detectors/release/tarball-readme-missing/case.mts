import { defineDetectorFixture } from '../../../../integration/helpers/detector-fixture-types';
import { removeReleaseOutputFileSetup } from '../../../../integration/helpers/release-fixture-output';
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
            value: 'required-files-missing',
          },
          {
            label: 'tarball',
            value: 'fixture-release-root-1.0.0.tgz',
          },
          {
            label: 'missing files',
            lines: ['README.md'],
          },
        ],
        filePath: 'packages/root/dist/package.json',
        packageManifestPath: 'packages/root/dist/package.json',
        packageName: '@fixture/release-root',
        reason: 'required-files-missing',
        task: 'release:check',
      },
    ],
    primaryCode: LIMINA_CHECK_ISSUE_CODES.releaseTarballHygiene,
  },
  id: 'release/tarball-readme-missing',
  kind: 'filesystem',
  setup: [removeReleaseOutputFileSetup({ fileName: 'README.md' })],
  tools: [],
});
