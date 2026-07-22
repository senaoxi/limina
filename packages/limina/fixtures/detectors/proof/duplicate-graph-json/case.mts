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
        code: LIMINA_CHECK_ISSUE_CODES.proofDuplicateGraphCoverage,
        evidence: [
          {
            label: 'diagnostic',
            lines: [
              '    - .limina/tsconfig/checkers/typescript/projects/packages/pkg/tsconfig.alpha.dts.json',
              '    - .limina/tsconfig/checkers/typescript/projects/packages/pkg/tsconfig.beta.dts.json',
            ],
          },
        ],
        filePath: 'packages/pkg/src/shared.json',
        packageManifestPath: 'packages/pkg/package.json',
        packageName: '@fixture/proof-duplicate-graph-json',
        task: 'proof:check',
      },
    ],
    primaryCode: LIMINA_CHECK_ISSUE_CODES.proofDuplicateGraphCoverage,
  },
  id: 'proof/duplicate-graph-json',
  kind: 'filesystem',
  setup: [],
  tools: ['typescript'],
});
