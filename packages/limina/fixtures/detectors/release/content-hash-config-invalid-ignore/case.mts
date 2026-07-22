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
        code: LIMINA_CHECK_ISSUE_CODES.releaseContentHash,
        evidence: [
          {
            label: 'release reason',
            value: 'config-invalid',
          },
          {
            label: 'dependency',
            value: '@fixture/release-dependency',
          },
          {
            label: 'source manifest',
          },
          {
            label: 'config field',
            value: 'release.contentHash.ignore',
          },
        ],
        filePath: 'limina.config.mts',
        packageManifestPath: 'packages/dependency/package.json',
        packageName: '@fixture/release-dependency',
        reason: 'config-invalid',
        task: 'release:check',
      },
    ],
    primaryCode: LIMINA_CHECK_ISSUE_CODES.releaseContentHash,
  },
  id: 'release/content-hash-config-invalid-ignore',
  kind: 'filesystem',
  setup: [],
  tools: [],
});
