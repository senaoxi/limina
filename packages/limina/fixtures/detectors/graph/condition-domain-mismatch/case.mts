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
        code: LIMINA_CHECK_ISSUE_CODES.graphConditionDomainMismatch,
        filePath:
          '.limina/tsconfig/checkers/typescript/projects/packages/app/tsconfig.web.dts.json',
        task: 'graph:check',
      },
    ],
    primaryCode: LIMINA_CHECK_ISSUE_CODES.graphConditionDomainMismatch,
  },
  id: 'graph/condition-domain-mismatch',
  kind: 'filesystem',
  setup: [],
  tools: ['typescript'],
});
