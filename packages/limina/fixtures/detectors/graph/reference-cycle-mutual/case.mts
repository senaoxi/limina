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
        code: LIMINA_CHECK_ISSUE_CODES.graphReferenceCycle,
        filePath:
          '.limina/tsconfig/checkers/typescript/projects/packages/a/tsconfig.dts.json',
        task: 'graph:check',
      },
    ],
    primaryCode: LIMINA_CHECK_ISSUE_CODES.graphReferenceCycle,
  },
  id: 'graph/reference-cycle-mutual',
  kind: 'filesystem',
  setup: [],
  tools: ['typescript'],
});
