import { defineDetectorFixture } from '../../../../integration/helpers/detector-fixture-types';
import { LIMINA_CHECK_ISSUE_CODES } from '../../../../src/check-reporting/codes';

export default defineDetectorFixture({
  command: ['check', 'detector'],
  copyPolicy: {
    excludedNames: [],
    includeBuildInfoFiles: false,
    includeOutputDirectories: false,
  },
  expected: {
    additionalCodes: [],
    exitCode: 1,
    issues: [
      {
        checkerName: 'typescript',
        code: LIMINA_CHECK_ISSUE_CODES.graphImportTargetUnmapped,
        evidence: [
          {
            label: 'import',
            value: '@fixture/graph-unmapped-internal',
          },
          { label: 'resolved file' },
        ],
        filePath: 'packages/app/src/index.ts',
        packageName: '@fixture/graph-unmapped-internal',
        task: 'graph:check',
      },
    ],
    primaryCode: LIMINA_CHECK_ISSUE_CODES.graphImportTargetUnmapped,
  },
  id: 'graph/import-target-unmapped',
  kind: 'filesystem',
  setup: [
    {
      kind: 'directory-link',
      path: 'repo/packages/app/node_modules/@fixture/graph-unmapped-internal',
      target: 'repo/packages/internal',
    },
  ],
  tools: ['typescript'],
});
