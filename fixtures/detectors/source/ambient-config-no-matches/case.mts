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
        code: LIMINA_CHECK_ISSUE_CODES.sourceAmbientDeclarationConfigInvalid,
        packageName: '<workspace>',
        scope: 'source.declarations.ambient[0]',
        task: 'source:check',
      },
    ],
    primaryCode: LIMINA_CHECK_ISSUE_CODES.sourceAmbientDeclarationConfigInvalid,
  },
  id: 'source/ambient-config-no-matches',
  kind: 'filesystem',
  setup: [],
  tools: ['typescript'],
});
