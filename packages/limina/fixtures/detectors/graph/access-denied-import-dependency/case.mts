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
        code: LIMINA_CHECK_ISSUE_CODES.graphAccessDenied,
        evidence: [
          { label: 'import', value: 'node:fs' },
          { label: 'denied dependency', value: 'node:*' },
        ],
        filePath: 'packages/app/src/index.ts',
        packageName: 'node:*',
        task: 'graph:check',
      },
    ],
    primaryCode: LIMINA_CHECK_ISSUE_CODES.graphAccessDenied,
  },
  id: 'graph/access-denied-import-dependency',
  kind: 'filesystem',
  setup: [],
  tools: ['typescript'],
});
