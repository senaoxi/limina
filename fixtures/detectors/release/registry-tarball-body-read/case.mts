import { defineDetectorFixture } from '../../../../integration/helpers/detector-fixture-types';
import { VALID_PLACEHOLDER_INTEGRITY } from '../../../../integration/helpers/release-detector-assertions';
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
            value: 'tarball-body-read',
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
        reason: 'tarball-body-read',
        task: 'release:check',
      },
    ],
    primaryCode: LIMINA_CHECK_ISSUE_CODES.releaseRegistry,
  },
  id: 'release/registry-tarball-body-read',
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
          kind: 'value',
          value: VALID_PLACEHOLDER_INTEGRITY,
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
          kind: 'incomplete-body',
          value: 'partial tarball',
        },
      },
    },
  },
  setup: [],
  tools: [],
});
