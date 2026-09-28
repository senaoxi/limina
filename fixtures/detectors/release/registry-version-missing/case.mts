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
        code: LIMINA_CHECK_ISSUE_CODES.releaseRegistry,
        evidence: [
          {
            label: 'release reason',
            value: 'version-missing',
          },
          {
            label: 'registry',
          },
          {
            label: 'dependency',
            value: '@fixture/release-dependency',
          },
          {
            label: 'dist-tag',
            value: 'latest',
          },
          {
            label: 'version',
            value: '1.0.0',
          },
        ],
        filePath: 'packages/dependency/package.json',
        packageManifestPath: 'packages/dependency/package.json',
        packageName: '@fixture/release-dependency',
        reason: 'version-missing',
        task: 'release:check',
      },
    ],
    primaryCode: LIMINA_CHECK_ISSUE_CODES.releaseRegistry,
  },
  id: 'release/registry-version-missing',
  kind: 'external-tool',
  registry: {
    expectedRequests: [
      {
        headers: {
          accept: 'application/json',
        },
        pathname: '/%40fixture%2Frelease-dependency',
      },
    ],
    metadata: {
      body: {
        kind: 'json',
        value: {
          'dist-tags': {
            latest: '1.0.0',
          },
          versions: {},
        },
      },
    },
    packageName: '@fixture/release-dependency',
  },
  setup: [],
  tools: [],
});
