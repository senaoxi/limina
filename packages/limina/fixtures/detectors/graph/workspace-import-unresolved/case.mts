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
        code: LIMINA_CHECK_ISSUE_CODES.graphWorkspaceImportUnresolved,
        evidence: [
          {
            label: 'import',
            value: '@fixture/graph-unresolved-internal/missing',
          },
        ],
        filePath: 'packages/app/src/index.ts',
        packageName: '@fixture/graph-unresolved-internal',
        task: 'graph:check',
      },
    ],
    primaryCode: LIMINA_CHECK_ISSUE_CODES.graphWorkspaceImportUnresolved,
  },
  id: 'graph/workspace-import-unresolved',
  kind: 'filesystem',
  setup: [
    {
      kind: 'directory-link',
      path: 'repo/packages/app/node_modules/@fixture/graph-unresolved-internal',
      target: 'repo/packages/internal',
    },
  ],
  tools: ['typescript'],
});
