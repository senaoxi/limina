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
        code: LIMINA_CHECK_ISSUE_CODES.workspaceOutputRootInvalid,
        evidence: [
          {
            label: 'workspace validation',
            lines: ['output root: alias'],
          },
        ],
        filePath: 'limina.config.mts',
        task: 'workspace:validate',
      },
    ],
    primaryCode: LIMINA_CHECK_ISSUE_CODES.workspaceOutputRootInvalid,
  },
  id: 'workspace/output-root-canonical-alias',
  kind: 'filesystem',
  setup: [
    {
      kind: 'directory-link',
      path: 'repo/alias',
      target: 'repo/packages/app',
    },
  ],
  tools: [],
});
