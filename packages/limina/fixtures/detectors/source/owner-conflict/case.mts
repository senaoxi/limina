import { defineDetectorFixture } from '../../../../integration/helpers/detector-fixture-types';
import { LIMINA_CHECK_ISSUE_CODES } from '../../../../src/check-reporting/codes';

export default defineDetectorFixture({
  command: ['check', 'detector'],
  expected: {
    additionalCodes: [],
    exitCode: 1,
    issues: [
      {
        code: LIMINA_CHECK_ISSUE_CODES.sourceTsconfigGovernance,
        evidence: [
          {
            label: 'diagnostic',
            lines: ['Tsconfig source file set crosses source owner scope:'],
          },
        ],
        filePath: 'shared/value.ts',
        packageManifestPath: 'packages/a/package.json',
        packageName: '@fixture/source-owner-conflict-a',
        task: 'source:check',
      },
      {
        code: LIMINA_CHECK_ISSUE_CODES.sourceTsconfigGovernance,
        evidence: [
          {
            label: 'diagnostic',
            lines: ['Tsconfig source file set crosses source owner scope:'],
          },
        ],
        filePath: 'shared/value.ts',
        packageManifestPath: 'packages/b/package.json',
        packageName: '@fixture/source-owner-conflict-b',
        task: 'source:check',
      },
      {
        code: LIMINA_CHECK_ISSUE_CODES.sourceTsconfigGovernance,
        evidence: [
          {
            label: 'diagnostic',
            lines: ['Tsconfig search cannot determine module owner:'],
          },
        ],
        filePath: 'shared/value.ts',
        packageName: '<workspace>',
        task: 'source:check',
      },
      {
        code: LIMINA_CHECK_ISSUE_CODES.sourceTsconfigGovernance,
        evidence: [
          {
            label: 'diagnostic',
            lines: [
              'Source module belongs to multiple tsconfig governance units:',
            ],
          },
        ],
        filePath: 'shared/value.ts',
        packageName: '<workspace>',
        task: 'source:check',
      },
      {
        code: LIMINA_CHECK_ISSUE_CODES.sourceTsconfigGovernance,
        evidence: [
          {
            label: 'diagnostic',
            lines: ['Tsconfig source file set mixes source owners:'],
          },
        ],
        filePath:
          '.limina/tsconfig/checkers/typescript/projects/packages/a/tsconfig.dts.json',
        packageName: '<workspace>',
        scope: '.limina/tsconfig/checkers/typescript/projects/packages/a',
        task: 'source:check',
      },
      {
        code: LIMINA_CHECK_ISSUE_CODES.sourceTsconfigGovernance,
        evidence: [
          {
            label: 'diagnostic',
            lines: ['Tsconfig source file set mixes source owners:'],
          },
        ],
        filePath:
          '.limina/tsconfig/checkers/typescript/projects/packages/b/tsconfig.dts.json',
        packageName: '<workspace>',
        scope: '.limina/tsconfig/checkers/typescript/projects/packages/b',
        task: 'source:check',
      },
      {
        code: LIMINA_CHECK_ISSUE_CODES.sourceTsconfigGovernance,
        evidence: [
          {
            label: 'diagnostic',
            lines: ['Tsconfig source file set mixes source owners:'],
          },
        ],
        filePath: 'packages/a/tsconfig.json',
        packageName: '<workspace>',
        scope: 'packages/a',
        task: 'source:check',
      },
      {
        code: LIMINA_CHECK_ISSUE_CODES.sourceTsconfigGovernance,
        evidence: [
          {
            label: 'diagnostic',
            lines: ['Tsconfig source file set mixes source owners:'],
          },
        ],
        filePath: 'packages/b/tsconfig.json',
        packageName: '<workspace>',
        scope: 'packages/b',
        task: 'source:check',
      },
      {
        code: LIMINA_CHECK_ISSUE_CODES.sourceOwnerInvalid,
        evidence: [
          {
            label: 'diagnostic',
            lines: ['Source module belongs to multiple source owners:'],
          },
        ],
        filePath: 'shared/value.ts',
        packageName: '<workspace>',
        task: 'source:check',
      },
    ],
    primaryCode: LIMINA_CHECK_ISSUE_CODES.sourceOwnerInvalid,
  },
  id: 'source/owner-conflict',
  kind: 'filesystem',
  setup: [],
  tools: ['typescript'],
});
