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
            value: 'packed-dependency-missing',
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
            label: 'packed manifest',
            value: 'fixture-release-root-1.0.0.tgz#package.json',
          },
        ],
        filePath: 'packages/root/dist/package.json',
        packageManifestPath: 'packages/root/dist/package.json',
        packageName: '@fixture/release-root',
        reason: 'packed-dependency-missing',
        task: 'release:check',
      },
    ],
    primaryCode: LIMINA_CHECK_ISSUE_CODES.releasePackedManifest,
  },
  id: 'release/packed-dependency-missing',
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
          files: [
            {
              content: 'export declare const value: number;\n',
              path: 'index.d.ts',
            },
            {
              content: 'export const value = 1;\n',
              path: 'index.js',
            },
            {
              content: 'MIT\n',
              path: 'LICENSE.md',
            },
            {
              content:
                '{\n  "exports": {\n    ".": "./index.js"\n  },\n  "license": "MIT",\n  "name": "@fixture/release-dependency",\n  "type": "module",\n  "types": "./index.d.ts",\n  "version": "1.0.0"\n}\n',
              path: 'package.json',
            },
            {
              content: '# Release fixture\n',
              path: 'README.md',
            },
          ],
          kind: 'package-tarball',
        },
      },
    },
  },
  setup: [createReleaseOutputPackageSetup({})],
  tools: [],
});
