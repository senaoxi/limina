import { defineDetectorFixture } from '../../../../integration/helpers/detector-fixture-types';
import { LIMINA_CHECK_ISSUE_CODES } from '../../../../src/check-reporting/codes';

export default defineDetectorFixture({
  command: ['check', 'detector'],
  expected: {
    additionalCodes: [],
    exitCode: 1,
    issues: [
      {
        code: LIMINA_CHECK_ISSUE_CODES.graphSourcePackageScopeMismatch,
        filePath: 'packages/a/tsconfig.json',
        reason:
          'a source leaf and each of its directly governed roots must share their nearest active package.json.',
        task: 'graph:prepare',
      },
      {
        code: LIMINA_CHECK_ISSUE_CODES.graphSourcePackageScopeMismatch,
        filePath: 'packages/b/tsconfig.json',
        reason:
          'a source leaf and each of its directly governed roots must share their nearest active package.json.',
        task: 'graph:prepare',
      },
    ],
    primaryCode: LIMINA_CHECK_ISSUE_CODES.graphSourcePackageScopeMismatch,
  },
  id: 'source/owner-conflict',
  kind: 'filesystem',
  setup: [],
  tools: ['typescript'],
});
