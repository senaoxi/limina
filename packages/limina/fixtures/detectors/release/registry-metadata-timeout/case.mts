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
            value: 'metadata-timeout',
          },
          {
            label: 'registry',
          },
          {
            label: 'dependency',
            value: '@fixture/release-dependency',
          },
          {
            label: 'timeout ms',
            value: '1000',
          },
        ],
        filePath: 'packages/dependency/package.json',
        packageManifestPath: 'packages/dependency/package.json',
        packageName: '@fixture/release-dependency',
        reason: 'metadata-timeout',
        task: 'release:check',
      },
    ],
    primaryCode: LIMINA_CHECK_ISSUE_CODES.releaseRegistry,
  },
  id: 'release/registry-metadata-timeout',
  kind: 'external-tool',
  registry: {
    // Leave room for first-fetch startup while keeping the response beyond the deadline.
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
        kind: 'delay',
        milliseconds: 5000,
        next: {
          kind: 'json',
          value: {},
        },
      },
    },
    packageName: '@fixture/release-dependency',
    requestTimeoutMs: 1000,
  },
  setup: [],
  tools: [],
});
