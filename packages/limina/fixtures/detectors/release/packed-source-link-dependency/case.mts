import { defineDetectorFixture } from '../../../../integration/helpers/detector-fixture-types';
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
            value: 'source-link-dependency',
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
            value: 'link:../dependency',
          },
          {
            label: 'source manifest',
          },
        ],
        filePath: 'packages/root/package.json',
        packageManifestPath: 'packages/root/package.json',
        packageName: '@fixture/release-root',
        reason: 'source-link-dependency',
        task: 'release:check',
      },
    ],
    primaryCode: LIMINA_CHECK_ISSUE_CODES.releasePackedManifest,
  },
  id: 'release/packed-source-link-dependency',
  kind: 'filesystem',
  setup: [],
  tools: [],
});
