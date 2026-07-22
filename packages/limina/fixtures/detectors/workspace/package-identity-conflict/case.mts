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
        code: LIMINA_CHECK_ISSUE_CODES.workspacePackageIdentityConflict,
        evidence: [
          {
            label: 'workspace validation',
            lines: [
              'lexical root: packages/alias',
              'lexical root: packages/real',
            ],
          },
        ],
        filePath: 'packages/alias/package.json',
        task: 'workspace:validate',
      },
    ],
    primaryCode: LIMINA_CHECK_ISSUE_CODES.workspacePackageIdentityConflict,
  },
  id: 'workspace/package-identity-conflict',
  kind: 'filesystem',
  setup: [
    {
      kind: 'directory-link',
      path: 'repo/packages/alias',
      target: 'repo/packages/real',
    },
  ],
  tools: [],
});
