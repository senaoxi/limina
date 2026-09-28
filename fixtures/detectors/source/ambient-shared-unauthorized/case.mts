import { defineDetectorFixture } from '../../../../integration/helpers/detector-fixture-types';
import { LIMINA_CHECK_ISSUE_CODES } from '../../../../src/check-reporting/codes';

export default defineDetectorFixture({
  command: ['check', 'detector'],
  expected: {
    additionalCodes: [],
    exitCode: 1,
    issues: [
      {
        code: LIMINA_CHECK_ISSUE_CODES.sourceAmbientDeclarationSharedUnauthorized,
        filePath: '__typings__/global.d.ts',
        packageName: '<workspace>',
        scope: 'source.declarations.ambient[0]',
        task: 'source:check',
      },
    ],
    primaryCode:
      LIMINA_CHECK_ISSUE_CODES.sourceAmbientDeclarationSharedUnauthorized,
  },
  id: 'source/ambient-shared-unauthorized',
  kind: 'filesystem',
  setup: [],
  tools: ['typescript'],
});
