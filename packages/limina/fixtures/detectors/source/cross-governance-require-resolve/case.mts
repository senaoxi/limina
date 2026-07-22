import { defineDetectorFixture } from '../../../../integration/helpers/detector-fixture-types';
import { LIMINA_CHECK_ISSUE_CODES } from '../../../../src/check-reporting/codes';

export default defineDetectorFixture({
  command: ['check', 'detector'],
  expected: {
    additionalCodes: [],
    exitCode: 1,
    issues: [
      {
        code: LIMINA_CHECK_ISSUE_CODES.sourceCrossGovernanceBoundary,
        evidence: [
          {
            label: 'diagnostic',
            lines: [
              '  imported specifier: ../fixture/pkg/src/value',
              '  resolved file: packages/app/fixture/pkg/src/value.ts',
              '  boundary kind: pnpm-workspace',
              '  boundary root: packages/app/fixture',
              '  boundary config: packages/app/fixture/pnpm-workspace.yaml',
            ],
          },
        ],
        filePath: 'packages/app/src/index.cts',
        packageManifestPath: 'packages/app/package.json',
        packageName: '@fixture/source-cross-governance-app',
        task: 'source:check',
      },
    ],
    primaryCode: LIMINA_CHECK_ISSUE_CODES.sourceCrossGovernanceBoundary,
  },
  id: 'source/cross-governance-require-resolve',
  kind: 'filesystem',
  setup: [],
  tools: ['typescript'],
});
