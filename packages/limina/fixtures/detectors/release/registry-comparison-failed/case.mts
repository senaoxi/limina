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
            value: 'comparison-failed',
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
          {
            label: 'tarball',
          },
        ],
        filePath: 'packages/dependency/package.json',
        packageManifestPath: 'packages/dependency/package.json',
        packageName: '@fixture/release-dependency',
        reason: 'comparison-failed',
        task: 'release:check',
      },
    ],
    primaryCode: LIMINA_CHECK_ISSUE_CODES.releaseRegistry,
  },
  id: 'release/registry-comparison-failed',
  kind: 'external-tool',
  registry: {
    expectedRequests: [
      {
        headers: {
          accept: 'application/json',
        },
        pathname: '/%40fixture%2Frelease-dependency',
      },
      {
        headers: {
          accept: 'application/octet-stream',
        },
        pathname: '/tarballs/release-dependency-1.0.0.tgz',
      },
    ],
    metadata: {
      body: {
        integrity: {
          kind: 'actual',
        },
        kind: 'package-metadata',
        tarballPath: '/tarballs/release-dependency-1.0.0.tgz',
        version: '1.0.0',
      },
    },
    packageName: '@fixture/release-dependency',
    tarballs: {
      '/tarballs/release-dependency-1.0.0.tgz': {
        body: {
          kind: 'text',
          value: 'not a tar archive',
        },
      },
    },
  },
  setup: [],
  tools: [],
});
