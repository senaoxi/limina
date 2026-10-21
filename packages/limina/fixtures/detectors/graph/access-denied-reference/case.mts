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
        checkerName: 'tsc',
        code: LIMINA_CHECK_ISSUE_CODES.graphAccessDenied,
        evidence: [{ label: 'import', value: './node' }],
        filePath: 'packages/app/src/runtime.ts',
        task: 'graph:check',
      },
      {
        checkerName: 'tsc',
        code: LIMINA_CHECK_ISSUE_CODES.graphAccessDenied,
        filePath:
          '.limina/tsconfig/checkers/tsc/projects/packages/app/tsconfig.runtime.dts.json',
        locations: [
          {
            filePath:
              '.limina/tsconfig/checkers/tsc/projects/packages/app/tsconfig.runtime.dts.json',
            label: 'referencing project',
          },
          {
            filePath:
              '.limina/tsconfig/checkers/tsc/projects/packages/app/tsconfig.node.dts.json',
            label: 'referenced project',
          },
        ],
        task: 'graph:check',
      },
    ],
    primaryCode: LIMINA_CHECK_ISSUE_CODES.graphAccessDenied,
  },
  id: 'graph/access-denied-reference',
  kind: 'filesystem',
  setup: [],
  tools: ['typescript'],
});
