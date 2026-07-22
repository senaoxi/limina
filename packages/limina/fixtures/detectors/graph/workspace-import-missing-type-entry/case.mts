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
        checkerName: 'typescript',
        code: LIMINA_CHECK_ISSUE_CODES.graphWorkspaceImportUnresolved,
        evidence: [
          {
            label: 'import',
            value: '@fixture/graph-runtime-only-internal/runtime',
          },
          {
            label: 'package export',
            value: '@fixture/graph-runtime-only-internal/runtime',
          },
        ],
        filePath: 'packages/app/src/index.ts',
        packageName: '@fixture/graph-runtime-only-internal',
        task: 'graph:check',
      },
    ],
    primaryCode: LIMINA_CHECK_ISSUE_CODES.graphWorkspaceImportUnresolved,
  },
  id: 'graph/workspace-import-missing-type-entry',
  kind: 'filesystem',
  setup: [
    {
      kind: 'directory-link',
      path: 'repo/packages/app/node_modules/@fixture/graph-runtime-only-internal',
      target: 'repo/packages/internal',
    },
  ],
  tools: ['typescript'],
});
