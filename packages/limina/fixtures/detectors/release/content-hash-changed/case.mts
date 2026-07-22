import { defineDetectorFixture } from '../../../../integration/helpers/detector-fixture-types';
import { createReleaseContentDiffEvidenceLine } from '../../../../integration/helpers/release-detector-assertions';
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
        code: LIMINA_CHECK_ISSUE_CODES.releaseContentHash,
        evidence: [
          {
            label: 'release reason',
            value: 'content-diff',
          },
          {
            label: 'dependency',
            value: '@fixture/release-dependency',
          },
          {
            label: 'source manifest',
          },
          {
            label: 'baseline tag',
            value: 'latest',
          },
          {
            label: 'baseline version',
            value: '1.0.0',
          },
          {
            label: 'content hash diffs',
            lines: [
              createReleaseContentDiffEvidenceLine({
                kind: 'changed',
                localContent: 'export const value = 2;\n',
                path: 'index.js',
                remoteContent: 'export const value = 1;\n',
              }),
            ],
          },
        ],
        filePath: 'packages/dependency/dist/index.js',
        packageManifestPath: 'packages/dependency/package.json',
        packageName: '@fixture/release-dependency',
        reason: 'content-diff',
        task: 'release:check',
      },
    ],
    primaryCode: LIMINA_CHECK_ISSUE_CODES.releaseContentHash,
  },
  id: 'release/content-hash-changed',
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
  setup: [
    createReleaseOutputFileSetup({
      content: 'export const value = 2;\n',
      fileName: 'index.js',
      overwrite: true,
      packageName: 'dependency',
    }),
  ],
  tools: [],
});
